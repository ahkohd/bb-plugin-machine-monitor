import { readFile } from "node:fs/promises";
import { cpus, freemem, loadavg, platform, totalmem } from "node:os";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, snapshotSchema, type ServerSnapshot } from "./contract.ts";
import {
  calculateCpuUsage,
  clampPercentage,
  createCollector,
  readCpuTimes,
  type CpuTimes,
} from "./lib/collector.ts";
import { createDemandSampler } from "./lib/demand-sampler.ts";
import { createPressureMonitor } from "./lib/pressure-monitor.ts";
import { PRESSURE_CHANNEL } from "./lib/pressure.ts";

export type { ServerSnapshot };
export {
  calculateCpuUsage,
  calculateNetworkRates,
  parseProcesses,
} from "./lib/collector.ts";

const machineSchema = z.object({
  id: z.string(),
  name: z.string(),
  connected: z.boolean(),
  isServer: z.boolean(),
});

export type Machine = z.infer<typeof machineSchema>;

export const rpcContract = defineRpcContract({
  metrics_snapshot: { input: z.null(), output: snapshotSchema },
  metrics_refresh: { input: z.null(), output: snapshotSchema },
  machines_list: { input: z.null(), output: z.object({ machines: z.array(machineSchema) }) },
  machine_snapshot: {
    input: z.object({ hostId: z.string().min(1), force: z.boolean() }),
    output: snapshotSchema,
  },
  monitor_status: { input: z.null(), output: z.object({ enabled: z.boolean(), notifications: z.boolean(), cursor: z.number(), active: z.array(z.object({ sequence: z.number(), type: z.enum(["incident", "recovery"]), metric: z.enum(["cpu", "memory"]), timestamp: z.number(), value: z.number(), peak: z.number(), durationSeconds: z.number(), threshold: z.number() })).max(2), recent: z.array(z.object({ sequence: z.number(), type: z.enum(["incident", "recovery"]), metric: z.enum(["cpu", "memory"]), timestamp: z.number(), value: z.number(), peak: z.number(), durationSeconds: z.number(), threshold: z.number() })).max(32) }) },
});

const MACHINE_TIMEOUT_MS = 8000;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    refreshIntervalSeconds: {
      type: "number",
      label: "Refresh interval (seconds)",
      experimental_schema: z.number().int().min(2).max(60),
      default: 5,
    },
    backgroundMonitoring: { type: "boolean", label: "Background CPU and memory monitoring", default: false },
    pressureNotifications: { type: "boolean", label: "In-app overload and recovery alerts", default: true },
  });
  const initialSettings = await settings.get();
  let refreshIntervalMs = initialSettings.refreshIntervalSeconds * 1000;
  let monitorCpu: CpuTimes | null = null;
  const monitor = createPressureMonitor(bb, async (signal) => {
    let current: CpuTimes;
    let availableBytes: number;
    if (platform() === "linux") {
      const [stat, meminfo] = await Promise.all([
        readFile("/proc/stat", { encoding: "utf8", signal }),
        readFile("/proc/meminfo", { encoding: "utf8", signal }),
      ]);
      const times = stat.split("\n", 1)[0].trim().split(/\s+/).slice(1, 9).map(Number);
      if (times.length < 8 || !times.every(Number.isFinite)) throw new Error("CPU counters unavailable");
      current = { idle: times[3] + times[4], total: times.reduce((sum, value) => sum + value, 0) };
      const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
      if (!available) throw new Error("Available memory counter unavailable");
      availableBytes = Number(available[1]) * 1024;
    } else {
      current = readCpuTimes(cpus());
      availableBytes = freemem();
    }
    signal.throwIfAborted();
    const cpu = calculateCpuUsage(monitorCpu, current);
    monitorCpu = current;
    const totalBytes = totalmem();
    const runtime = process.memoryUsage();
    return { cpu, memory: totalBytes > 0 ? clampPercentage((1 - availableBytes / totalBytes) * 100) : null, load1: loadavg()[0] ?? 0, rssBytes: runtime.rss, heapUsedBytes: runtime.heapUsed, availableBytes, totalBytes };
  }, () => { monitorCpu = null; });
  monitor.configure(initialSettings.backgroundMonitoring, initialSettings.pressureNotifications);
  settings.onChange((next) => {
    refreshIntervalMs = next.refreshIntervalSeconds * 1000;
    sampler.intervalChanged();
    monitor.configure(next.backgroundMonitoring, next.pressureNotifications);
  });
  bb.background.service("pressure-monitor", { start: (signal) => monitor.start(signal) });

  const collector = createCollector(() => refreshIntervalMs);
  const collect = collector.collect;

  const sampler = createDemandSampler({
    collect,
    intervalMs: () => refreshIntervalMs,
    reset: collector.reset,
  });
  const sample = async () => {
    const snapshot = await sampler.sample();
    // Settings may change while a snapshot is cached; clients need the new cadence now.
    return snapshot.refreshIntervalMs === refreshIntervalMs ? snapshot : { ...snapshot, refreshIntervalMs };
  };

  const hostClient = bb.hosts.experimental_client({ contract: hostContract });

  const primaryHostId = async (): Promise<string | null> =>
    (await bb.sdk.system.config()).primaryHostId ?? null;

  const listMachines = async (): Promise<Machine[]> => {
    const [hosts, serverHostId] = await Promise.all([
      bb.sdk.hosts.list({ type: "persistent" }),
      primaryHostId(),
    ]);
    return hosts
      .map((host) => ({
        id: host.id,
        name: host.name,
        connected: host.status === "connected",
        isServer: host.id === serverHostId,
      }))
      .sort(
        (left, right) =>
          Number(right.isServer) - Number(left.isServer) ||
          left.name.localeCompare(right.name),
      );
  };

  const machineSnapshot = async (hostId: string, force: boolean) => {
    if (hostId === (await primaryHostId())) {
      return force ? sampler.sample(true) : sample();
    }
    return hostClient.call(
      "machine_snapshot",
      { refreshIntervalMs, force },
      { hostId, timeoutMs: MACHINE_TIMEOUT_MS },
    );
  };

  bb.rpc.register(rpcContract, {
    metrics_snapshot: () => sample(),
    metrics_refresh: () => sampler.sample(true),
    machines_list: async () => ({ machines: await listMachines() }),
    machine_snapshot: ({ hostId, force }) => machineSnapshot(hostId, force),
    monitor_status: () => monitor.status(),
  });

  const usage = ["Usage:", "  bb beacon snapshot [--json]", "  bb beacon health [--json]", "  bb beacon logs [--json] [--limit 1..500]", "  bb beacon test-alert"].join("\n");
  bb.cli.register({
    name: "beacon",
    summary: "Inspect BB server resource usage and health",
    commands: [
      { name: "snapshot", summary: "Show current server statistics", usage: "bb beacon snapshot [--json]" },
      { name: "health", summary: "Show the current pressure assessment", usage: "bb beacon health [--json]" },
      { name: "logs", summary: "Read bounded monitoring history; --json exports JSONL", usage: "bb beacon logs [--json] [--limit 1..500]" },
      { name: "test-alert", summary: "Send a labeled in-app alert preview to visible BB clients", usage: "bb beacon test-alert" },
    ],
    async run(argv) {
      if (argv[0] === "test-alert") {
        if (argv.length !== 1) return { exitCode: 1, stderr: usage };
        const current = await settings.get();
        if (!current.backgroundMonitoring || !current.pressureNotifications) return { exitCode: 1, stderr: "Enable backgroundMonitoring and pressureNotifications before testing in-app alerts." };
        // Ephemeral preview only: no incident state, cursor, log, or metric changes.
        bb.realtime.publish(PRESSURE_CHANNEL, { type: "test" });
        return { exitCode: 0, stdout: "Test alert broadcast to connected BB clients. Keep BB visible to see it; this is not an OS push notification." };
      }
      if (argv[0] === "logs") {
        let limit = 100;
        let json = false;
        for (let i = 1; i < argv.length; i++) {
          if (argv[i] === "--json" && !json) json = true;
          else if (argv[i] === "--limit" && /^\d+$/.test(argv[i + 1] ?? "")) {
            limit = Number(argv[++i]);
            if (limit < 1 || limit > 500) return { exitCode: 1, stderr: usage };
          } else return { exitCode: 1, stderr: usage };
        }
        const entries = monitor.logs(limit);
        return { exitCode: 0, stdout: json ? entries.map((entry) => JSON.stringify(entry)).join("\n") : entries.length ? entries.map((entry) => `${new Date(entry.timestamp).toISOString()} ${entry.type} ${JSON.stringify(entry)}`).join("\n") : "No monitoring logs yet. Enable backgroundMonitoring to collect diagnostics." };
      }
      const json = argv.includes("--json");
      const command = argv.find((argument) => argument !== "--json");
      if (argv.filter((argument) => argument !== "--json").length > 1) return { exitCode: 1, stderr: usage };
      if (command === undefined || command === "help" || command === "--help") return { exitCode: 0, stdout: usage };
      if (command !== "snapshot" && command !== "health") return { exitCode: 1, stderr: usage };
      const snapshot = await sample();
      if (command === "snapshot") {
        if (json) return { exitCode: 0, stdout: JSON.stringify(snapshot) };
        return {
          exitCode: 0,
          stdout: [
            `CPU: ${snapshot.cpu.usagePercent === null ? "sampling" : `${snapshot.cpu.usagePercent.toFixed(1)}%`} (${snapshot.cpu.cores} cores)`,
            `Load: ${snapshot.cpu.loadAverage.map((value) => value.toFixed(2)).join(" / ")}`,
            `Memory: ${snapshot.memory.usagePercent.toFixed(1)}% used`,
            `Disk: ${snapshot.disk ? `${snapshot.disk.usagePercent.toFixed(1)}% used` : "unavailable"}`,
            snapshot.processes.available ? `Processes: ${snapshot.processes.total} total, ${snapshot.processes.running} running` : "Processes: unavailable",
            `Updated: ${snapshot.timestamp}`,
          ].join("\n"),
        };
      }
      if (command === "health") {
        if (json) return { exitCode: 0, stdout: JSON.stringify(snapshot.health) };
        return {
          exitCode: snapshot.health.status === "critical" ? 2 : 0,
          stdout: snapshot.health.issues.length === 0 ? "healthy — no resource pressure detected" : `${snapshot.health.status}\n${snapshot.health.issues.map((issue) => `- ${issue.message}`).join("\n")}`,
        };
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  bb.log.info("Beacon loaded");
  bb.onDispose(() => { monitor.dispose(); sampler.dispose(); bb.log.info("Beacon disposed"); });
}
