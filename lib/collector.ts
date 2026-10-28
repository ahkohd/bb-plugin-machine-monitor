import { execFile } from "node:child_process";
import { readFile, readlink, statfs } from "node:fs/promises";
import { arch, cpus, freemem, hostname, loadavg, platform, release, totalmem, uptime } from "node:os";
import { promisify } from "node:util";
import { basename } from "node:path";
import type { MetricPoint, Processes, ServerSnapshot } from "../contract.ts";

const ROOT_MOUNT = "/";
const HISTORY_LIMIT = 72;
const execFileAsync = promisify(execFile);

export interface CpuTimes { idle: number; total: number }
interface NetworkTotals { interface: string; rxBytes: number; txBytes: number }
interface MemoryDetails {
  availableBytes: number;
  cachedBytes: number;
  buffersBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}

export function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function calculateNetworkRates(previous: NetworkTotals | null, current: NetworkTotals, elapsedSeconds: number | null) {
  if (!previous || previous.interface !== current.interface || elapsedSeconds === null || !Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0 || current.rxBytes < previous.rxBytes || current.txBytes < previous.txBytes) {
    return { rxBytesPerSecond: null, txBytesPerSecond: null };
  }
  return { rxBytesPerSecond: (current.rxBytes - previous.rxBytes) / elapsedSeconds, txBytesPerSecond: (current.txBytes - previous.txBytes) / elapsedSeconds };
}

export function calculateCpuUsage(previous: CpuTimes | null, current: CpuTimes): number | null {
  if (previous === null) return null;
  const idleDelta = current.idle - previous.idle;
  const totalDelta = current.total - previous.total;
  if (totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta) return null;
  return clampPercentage(((totalDelta - idleDelta) / totalDelta) * 100);
}

export function cpuTimesFor(cpu: ReturnType<typeof cpus>[number]): CpuTimes {
  return {
    idle: cpu.times.idle,
    total: Object.values(cpu.times).reduce((sum, value) => sum + value, 0),
  };
}

export function readCpuTimes(cpuList: ReturnType<typeof cpus>): CpuTimes {
  return cpuList.map(cpuTimesFor).reduce(
    (result, current) => ({ idle: result.idle + current.idle, total: result.total + current.total }),
    { idle: 0, total: 0 },
  );
}

async function readMemoryDetails(signal: AbortSignal): Promise<MemoryDetails> {
  const fallbackAvailable = freemem();
  const fallback: MemoryDetails = {
    availableBytes: fallbackAvailable,
    cachedBytes: 0,
    buffersBytes: 0,
    swapTotalBytes: 0,
    swapUsedBytes: 0,
  };
  if (platform() !== "linux") return fallback;
  try {
    const source = await readFile("/proc/meminfo", { encoding: "utf8", signal });
    const values = new Map<string, number>();
    for (const line of source.split("\n")) {
      const match = /^(\w+):\s+(\d+)\s+kB$/.exec(line.trim());
      if (match) values.set(match[1], Number(match[2]) * 1024);
    }
    const swapTotalBytes = values.get("SwapTotal") ?? 0;
    const swapFreeBytes = values.get("SwapFree") ?? 0;
    return {
      availableBytes: values.get("MemAvailable") ?? fallbackAvailable,
      cachedBytes: (values.get("Cached") ?? 0) + (values.get("SReclaimable") ?? 0),
      buffersBytes: values.get("Buffers") ?? 0,
      swapTotalBytes,
      swapUsedBytes: Math.max(0, swapTotalBytes - swapFreeBytes),
    };
  } catch {
    return fallback;
  }
}

async function readDisk() {
  try {
    const stats = await statfs(ROOT_MOUNT);
    const totalBytes = stats.blocks * stats.bsize;
    const usedBytes = (stats.blocks - stats.bfree) * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    return {
      mount: ROOT_MOUNT,
      totalBytes,
      usedBytes,
      freeBytes,
      usagePercent: totalBytes === 0 ? 0 : clampPercentage((usedBytes / totalBytes) * 100),
    };
  } catch {
    return null;
  }
}

export function parseNetstatLinks(source: string): NetworkTotals | null {
  const candidates = source.split("\n").flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || !fields[2]?.startsWith("<Link#")) return [];
    const name = fields[0].replace(/\*$/, "");
    if (name.startsWith("lo")) return [];
    const rxBytes = Number(fields[fields.length - 5]);
    const txBytes = Number(fields[fields.length - 2]);
    if (!Number.isSafeInteger(rxBytes) || !Number.isSafeInteger(txBytes) || rxBytes < 0 || txBytes < 0) return [];
    return [{ interface: name, rxBytes, txBytes }];
  });
  return candidates.sort(
    (left, right) => right.rxBytes + right.txBytes - left.rxBytes - left.txBytes,
  )[0] ?? null;
}

async function readMacNetworkTotals(signal: AbortSignal): Promise<NetworkTotals | null> {
  try {
    const { stdout } = await execFileAsync("netstat", ["-ibn"], {
      timeout: 1500,
      maxBuffer: 512 * 1024,
      signal,
      env: { ...process.env, LC_ALL: "C" },
    });
    return parseNetstatLinks(stdout);
  } catch {
    return null;
  }
}

async function readNetworkTotals(signal: AbortSignal): Promise<NetworkTotals | null> {
  if (platform() === "darwin") return readMacNetworkTotals(signal);
  if (platform() !== "linux") return null;
  try {
    const source = await readFile("/proc/net/dev", { encoding: "utf8", signal });
    const candidates = source.split("\n").slice(2).map((line) => {
      const [rawName, rawStats] = line.split(":");
      if (!rawName || !rawStats) return null;
      const name = rawName.trim();
      const stats = rawStats.trim().split(/\s+/).map(Number);
      if (name === "lo" || stats.length < 9 || !Number.isFinite(stats[0]) || !Number.isFinite(stats[8]) || stats[0] < 0 || stats[8] < 0) return null;
      return { interface: name, rxBytes: stats[0] ?? 0, txBytes: stats[8] ?? 0 };
    }).filter((value): value is NetworkTotals => value !== null);
    return candidates.sort(
      (left, right) => right.rxBytes + right.txBytes - left.rxBytes - left.txBytes,
    )[0] ?? null;
  } catch {
    return null;
  }
}

export function parseProcesses(source: string): Processes {
  const rows = source.split("\n").flatMap((line) => {
    // comm comes last: executable names may contain whitespace. Never read cmdline.
    const match = /^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match || match[6] === "ps") return [];
    const [pid, cpuPercent, memoryPercent, rssKiB] = match.slice(1, 5).map(Number);
    if (!Number.isSafeInteger(pid) || pid <= 0 || ![cpuPercent, memoryPercent, rssKiB * 1024].every(Number.isFinite)) return [];
    return [{ pid, name: match[6].slice(0, 128), cpuPercent, memoryPercent, rssBytes: rssKiB * 1024, running: match[5].startsWith("R") }];
  });
  return {
    available: true,
    total: rows.length,
    running: rows.filter((row) => row.running).length,
    top: rows.sort((a, b) => b.cpuPercent - a.cpuPercent || a.pid - b.pid).slice(0, 6).map(({ running: _running, ...row }) => row),
  };
}

async function readProcesses(signal: AbortSignal): Promise<Processes> {
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-eo", "pid=,%cpu=,%mem=,rss=,stat=,comm="],
      { timeout: 1500, maxBuffer: 512 * 1024, signal, env: { ...process.env, LC_ALL: "C" } },
    );
    const processes = parseProcesses(stdout);
    if (platform() !== "linux") {
      for (const entry of processes.top) entry.name = basename(entry.name).slice(0, 128);
    } else {
      // Node can rename comm to MainThread. Resolve six symlinks, not command-line
      // contents (which can be large or include credentials and arguments).
      await Promise.all(processes.top.map(async (entry) => {
        try { entry.name = basename((await readlink(`/proc/${entry.pid}/exe`)).replace(/ \(deleted\)$/, "")).slice(0, 128); }
        catch { /* The process may have exited, or ptrace permissions may deny access. */ }
      }));
    }
    return processes;
  } catch {
    return { available: false, total: 0, running: 0, top: [] };
  }
}

function assessHealth(
  cpuPercent: number | null,
  memoryPercent: number,
  diskPercent: number | null,
  fiveMinuteLoad: number,
  coreCount: number,
): ServerSnapshot["health"] {
  const issues: ServerSnapshot["health"]["issues"] = [];
  const addThresholdIssue = (label: string, value: number) => {
    if (value >= 95) issues.push({ severity: "critical", label, message: `${label} is at ${value.toFixed(1)}%.` });
    else if (value >= 85) issues.push({ severity: "warning", label, message: `${label} is at ${value.toFixed(1)}%.` });
  };
  if (cpuPercent !== null) addThresholdIssue("CPU", cpuPercent);
  addThresholdIssue("Memory", memoryPercent);
  if (diskPercent !== null) addThresholdIssue("Disk", diskPercent);
  const normalizedLoad = fiveMinuteLoad / coreCount;
  if (normalizedLoad >= 1.5) {
    issues.push({ severity: "critical", label: "System load", message: `Five-minute load is ${fiveMinuteLoad.toFixed(2)} across ${coreCount} cores.` });
  } else if (normalizedLoad >= 1) {
    issues.push({ severity: "warning", label: "System load", message: `Five-minute load is ${fiveMinuteLoad.toFixed(2)} across ${coreCount} cores.` });
  }
  return {
    status: issues.some((issue) => issue.severity === "critical") ? "critical" : issues.length > 0 ? "warning" : "healthy",
    issues,
  };
}

export function createCollector(refreshIntervalMs: () => number) {
  let previousCpuTimes: CpuTimes | null = null;
  let previousPerCoreTimes: CpuTimes[] | null = null;
  let previousNetworkTotals: NetworkTotals | null = null;
  let previousNetworkTimestamp: number | null = null;
  const history: MetricPoint[] = [];

  async function collect(signal: AbortSignal): Promise<ServerSnapshot> {
    const cpuList = cpus();
    const cpuTimes = readCpuTimes(cpuList);
    const perCoreTimes = cpuList.map(cpuTimesFor);
    const sameCoreCount = previousPerCoreTimes?.length === perCoreTimes.length;
    const usagePercent = calculateCpuUsage(sameCoreCount ? previousCpuTimes : null, cpuTimes);
    const perCoreUsagePercent = perCoreTimes.map((current, index) =>
      calculateCpuUsage(sameCoreCount ? previousPerCoreTimes?.[index] ?? null : null, current),
    );
    previousCpuTimes = cpuTimes;
    previousPerCoreTimes = perCoreTimes;

    const [memoryDetails, disk, networkReading, processes] = await Promise.all([
      readMemoryDetails(signal), readDisk(), readNetworkTotals(signal).then((totals) => ({ totals, time: performance.now() })), readProcesses(signal),
    ]);
    signal.throwIfAborted();
    const totalBytes = totalmem();
    const freeBytes = freemem();
    const availableBytes = Math.min(totalBytes, Math.max(0, memoryDetails.availableBytes));
    const usedBytes = totalBytes - availableBytes;
    const memoryPercent = totalBytes === 0 ? 0 : clampPercentage((usedBytes / totalBytes) * 100);
    const loads = loadavg();
    const coreCount = Math.max(1, cpuList.length);
    const memoryUsage = process.memoryUsage();
    const timestamp = Date.now();
    const { totals: networkTotals, time: networkTimestamp } = networkReading;
    const elapsedSeconds = previousNetworkTimestamp === null ? null : (networkTimestamp - previousNetworkTimestamp) / 1000;
    const network = networkTotals === null ? null : {
      interface: networkTotals.interface,
      ...calculateNetworkRates(previousNetworkTotals, networkTotals, elapsedSeconds),
      rxTotalBytes: networkTotals.rxBytes,
      txTotalBytes: networkTotals.txBytes,
    };
    previousNetworkTotals = networkTotals;
    previousNetworkTimestamp = networkTimestamp;

    history.push({
      timestamp,
      cpuPercent: usagePercent,
      memoryPercent,
      networkRxBytesPerSecond: network?.rxBytesPerSecond ?? null,
      networkTxBytesPerSecond: network?.txBytesPerSecond ?? null,
    });
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);

    const snapshot: ServerSnapshot = {
      timestamp: new Date(timestamp).toISOString(),
      refreshIntervalMs: refreshIntervalMs(),
      host: { hostname: hostname(), platform: platform(), release: release(), arch: arch(), uptimeSeconds: uptime() },
      cpu: {
        model: cpuList[0]?.model.trim() || "Unknown CPU",
        cores: coreCount,
        speedMHz: cpuList.length === 0 ? 0 : cpuList.reduce((sum, cpu) => sum + cpu.speed, 0) / cpuList.length,
        usagePercent,
        perCoreUsagePercent,
        loadAverage: [loads[0] ?? 0, loads[1] ?? 0, loads[2] ?? 0],
      },
      memory: {
        totalBytes,
        usedBytes,
        freeBytes,
        availableBytes,
        cachedBytes: memoryDetails.cachedBytes,
        buffersBytes: memoryDetails.buffersBytes,
        swapTotalBytes: memoryDetails.swapTotalBytes,
        swapUsedBytes: memoryDetails.swapUsedBytes,
        usagePercent: memoryPercent,
      },
      disk,
      network,
      processes,
      runtime: {
        pid: process.pid,
        nodeVersion: process.version,
        processUptimeSeconds: process.uptime(),
        rssBytes: memoryUsage.rss,
        heapUsedBytes: memoryUsage.heapUsed,
        heapTotalBytes: memoryUsage.heapTotal,
        externalBytes: memoryUsage.external,
      },
      health: assessHealth(usagePercent, memoryPercent, disk?.usagePercent ?? null, loads[1] ?? 0, coreCount),
      history: [...history],
    };
    return snapshot;
  }

  function reset() {
    previousCpuTimes = null;
    previousPerCoreTimes = null;
    previousNetworkTotals = null;
    previousNetworkTimestamp = null;
    history.length = 0;
  }

  return { collect, reset };
}
