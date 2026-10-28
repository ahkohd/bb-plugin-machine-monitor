import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
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

function measuredWatts(value: unknown): number | null {
  const watts = finiteOrNull(value, 1000);
  return watts === null || watts === 0 ? null : watts;
}

export function parseSensorOutput(source: string): Omit<MacSensors, "gpuPercent"> | null {
  try {
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = parsed as Record<string, unknown>;
    return {
      cpuTempC: finiteOrNull(value.cpuTempC, 150),
      gpuTempC: finiteOrNull(value.gpuTempC, 150),
      cpuWatts: measuredWatts(value.cpuWatts),
      gpuWatts: measuredWatts(value.gpuWatts),
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

const HELPER_DIRECTORY = join(homedir(), "Library", "Caches", "bb-plugin-beacon");
const WRITABLE_BY_OTHERS = 0o022;

async function ownedAndPrivate(path: string, kind: "file" | "directory"): Promise<boolean> {
  try {
    const stats = await lstat(path);
    const rightKind = kind === "file" ? stats.isFile() : stats.isDirectory();
    return rightKind && stats.uid === process.getuid?.() && (stats.mode & WRITABLE_BY_OTHERS) === 0;
  } catch {
    return false;
  }
}

async function holdsHelper(path: string): Promise<boolean> {
  if (!(await ownedAndPrivate(path, "file"))) return false;
  try {
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    return digest === MAC_SENSORS_DIGEST;
  } catch {
    return false;
  }
}

async function writeHelper(): Promise<string | null> {
  await mkdir(HELPER_DIRECTORY, { recursive: true, mode: 0o700 }).catch(() => undefined);
  if (!(await ownedAndPrivate(HELPER_DIRECTORY, "directory"))) return null;
  const path = join(HELPER_DIRECTORY, `beacon-sensors-${MAC_SENSORS_DIGEST.slice(0, 16)}`);
  if (await holdsHelper(path)) return path;
  const partial = `${path}.${process.pid}.${Date.now()}.partial`;
  try {
    await writeFile(partial, Buffer.from(MAC_SENSORS_BINARY, "base64"), { mode: 0o700, flag: "wx" });
    await rename(partial, path);
    return (await holdsHelper(path)) ? path : null;
  } catch {
    await rm(partial, { force: true });
    return null;
  }
}

function helperWentMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "EACCES";
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
  } catch (error) {
    if (helperWentMissing(error)) helperPath = null;
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
