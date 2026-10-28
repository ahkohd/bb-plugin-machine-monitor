import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MAC_SENSORS_BINARY, MAC_SENSORS_DIGEST } from "./mac-sensors-binary.ts";

const execFileAsync = promisify(execFile);

export interface MacSensors {
  cpuTempC: number | null;
  gpuTempC: number | null;
  cpuWatts: number | null;
  gpuWatts: number | null;
  gpuPercent: number | null;
}

function finiteOrNull(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
}

export function parseSensorOutput(source: string): Omit<MacSensors, "gpuPercent"> | null {
  try {
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = parsed as Record<string, unknown>;
    return {
      cpuTempC: finiteOrNull(value.cpuTempC, 150),
      gpuTempC: finiteOrNull(value.gpuTempC, 150),
      cpuWatts: finiteOrNull(value.cpuWatts, 1000),
      gpuWatts: finiteOrNull(value.gpuWatts, 1000),
    };
  } catch {
    return null;
  }
}

export function parseGpuUtilization(source: string): number | null {
  const match = /"Device Utilization %"\s*=\s*(\d+)/.exec(source);
  return match ? finiteOrNull(Number(match[1]), 100) : null;
}

let helperPath: Promise<string | null> | null = null;

async function holdsHelper(path: string): Promise<boolean> {
  try {
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    return digest === MAC_SENSORS_DIGEST;
  } catch {
    return false;
  }
}

async function writeHelper(): Promise<string | null> {
  const path = join(tmpdir(), `beacon-sensors-${MAC_SENSORS_DIGEST.slice(0, 16)}`);
  if (await holdsHelper(path)) return path;
  try {
    const partial = `${path}.${process.pid}.partial`;
    await writeFile(partial, Buffer.from(MAC_SENSORS_BINARY, "base64"), { mode: 0o755 });
    await chmod(partial, 0o755);
    await rename(partial, path);
    return (await holdsHelper(path)) ? path : null;
  } catch {
    return null;
  }
}

async function readHelper(signal: AbortSignal) {
  helperPath ??= writeHelper().then((path) => {
    if (path === null) helperPath = null;
    return path;
  });
  const path = await helperPath;
  if (path === null) return null;
  try {
    const { stdout } = await execFileAsync(path, [], { timeout: 3000, maxBuffer: 64 * 1024, signal });
    return parseSensorOutput(stdout);
  } catch {
    return null;
  }
}

async function readGpuUtilization(signal: AbortSignal): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ioreg", ["-r", "-d", "1", "-c", "IOAccelerator"], { timeout: 1500, maxBuffer: 4 * 1024 * 1024, signal });
    return parseGpuUtilization(stdout);
  } catch {
    return null;
  }
}

export async function readMacSensors(signal: AbortSignal): Promise<MacSensors | null> {
  if (platform() !== "darwin" || arch() !== "arm64") return null;
  const [readings, gpuPercent] = await Promise.all([readHelper(signal), readGpuUtilization(signal)]);
  if (readings === null && gpuPercent === null) return null;
  return {
    cpuTempC: readings?.cpuTempC ?? null,
    gpuTempC: readings?.gpuTempC ?? null,
    cpuWatts: readings?.cpuWatts ?? null,
    gpuWatts: readings?.gpuWatts ?? null,
    gpuPercent,
  };
}
