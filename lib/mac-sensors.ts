import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import type { Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { MAC_SENSORS_BINARY, MAC_SENSORS_DIGEST } from "./mac-sensors-binary.ts";

const READING_TIMEOUT_MS = 3000;

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

export function parseSensorOutput(source: string): MacSensors | null {
  try {
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = parsed as Record<string, unknown>;
    return {
      cpuTempC: finiteOrNull(value.cpuTempC, 150),
      gpuTempC: finiteOrNull(value.gpuTempC, 150),
      cpuWatts: measuredWatts(value.cpuWatts),
      gpuWatts: measuredWatts(value.gpuWatts),
      gpuPercent: finiteOrNull(value.gpuPercent, 100),
    };
  } catch {
    return null;
  }
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

const HELPER_NAME = `beacon-sensors-${MAC_SENSORS_DIGEST.slice(0, 16)}`;

async function removeOlderHelpers(): Promise<void> {
  const names = await readdir(HELPER_DIRECTORY).catch(() => []);
  await Promise.all(names
    .filter((name) => name.startsWith("beacon-sensors-") && name !== HELPER_NAME && !name.endsWith(".partial"))
    .map((name) => rm(join(HELPER_DIRECTORY, name), { force: true })));
}

async function writeHelper(): Promise<string | null> {
  await mkdir(HELPER_DIRECTORY, { recursive: true, mode: 0o700 }).catch(() => undefined);
  if (!(await ownedAndPrivate(HELPER_DIRECTORY, "directory"))) return null;
  await removeOlderHelpers();
  const path = join(HELPER_DIRECTORY, HELPER_NAME);
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

interface RunningHelper {
  request(): Promise<string | null>;
  stop(): void;
}

let runningHelper: RunningHelper | null = null;

function startHelper(path: string): RunningHelper {
  const child = spawn(path, ["--serve"], { stdio: ["pipe", "pipe", "ignore"] });
  const waiting: Array<(line: string | null) => void> = [];
  const finish = () => {
    if (runningHelper === helper) runningHelper = null;
    for (const resolve of waiting.splice(0)) resolve(null);
  };
  const helper: RunningHelper = {
    request: () => new Promise((resolve) => {
      waiting.push(resolve);
      child.stdin.write("\n");
    }),
    stop: () => child.kill(),
  };
  createInterface({ input: child.stdout }).on("line", (line) => waiting.shift()?.(line));
  child.on("exit", finish);
  child.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "EACCES") helperPath = null;
    finish();
  });
  child.stdin.on("error", finish);
  child.unref();
  (child.stdin as unknown as Socket).unref();
  (child.stdout as unknown as Socket).unref();
  return helper;
}

export function stopMacSensors(): void {
  runningHelper?.stop();
  runningHelper = null;
}

async function helperFor(): Promise<RunningHelper | null> {
  if (runningHelper) return runningHelper;
  helperPath ??= writeHelper().then((path) => {
    if (path === null) helperPath = null;
    return path;
  });
  const path = await helperPath;
  if (path === null) return null;
  runningHelper ??= startHelper(path);
  return runningHelper;
}

async function readHelper(signal: AbortSignal): Promise<MacSensors | null> {
  const helper = await helperFor();
  if (!helper || signal.aborted) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      helper.stop();
      resolve(null);
    }, READING_TIMEOUT_MS);
  });
  try {
    const line = await Promise.race([helper.request(), timedOut]);
    return line === null ? null : parseSensorOutput(line);
  } finally {
    clearTimeout(timer);
  }
}

export function readMacSensors(signal: AbortSignal): Promise<MacSensors | null> {
  if (platform() !== "darwin" || arch() !== "arm64") return Promise.resolve(null);
  return readHelper(signal);
}
