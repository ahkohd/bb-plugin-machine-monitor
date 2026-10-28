import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseLinuxBattery, parseMacBattery } from "../lib/battery.ts";
import { parseGpuUtilization, parseSensorOutput } from "../lib/mac-sensors.ts";

const macIoreg = [
  '      "CurrentCapacity" = 23',
  '      "TimeRemaining" = 74',
  '      "Amperage" = 18446744073709549843',
  '      "AvgTimeToFull" = 65535',
  '      "ExternalConnected" = No',
  '      "NominalChargeCapacity" = 7612',
  '      "FullyCharged" = No',
  '      "MaxCapacity" = 100',
  '      "InstantAmperage" = 18446744073709549843',
  '      "Temperature" = 3076',
  '      "AvgTimeToEmpty" = 74',
  '      "IsCharging" = No',
  '      "DesignCapacity" = 8579',
  '      "Voltage" = 11149',
  '      "CycleCount" = 146',
].join("\n");

test("reads a discharging MacBook battery from ioreg", () => {
  assert.deepEqual(parseMacBattery(macIoreg), {
    percent: 23,
    state: "discharging",
    minutesRemaining: 74,
    healthPercent: 88.7,
    cycleCount: 146,
    watts: 19.8,
    temperatureC: 30.8,
  });
});

test("a charging Mac reports time to full, and an estimate still running reports none", () => {
  const charging = macIoreg.replace('"IsCharging" = No', '"IsCharging" = Yes').replace('"ExternalConnected" = No', '"ExternalConnected" = Yes');
  assert.equal(parseMacBattery(charging).state, "charging");
  assert.equal(parseMacBattery(charging).minutesRemaining, null);
  const full = macIoreg.replace('"FullyCharged" = No', '"FullyCharged" = Yes').replace('"ExternalConnected" = No', '"ExternalConnected" = Yes');
  assert.equal(parseMacBattery(full).state, "full");
});

test("a Mac without a battery reports none", () => {
  assert.equal(parseMacBattery(""), null);
});

test("reads a Linux laptop battery from sysfs", () => {
  assert.deepEqual(parseLinuxBattery({
    capacity: "64\n",
    status: "Discharging\n",
    power_now: "9500000\n",
    energy_now: "38000000\n",
    energy_full: "50000000\n",
    energy_full_design: "57000000\n",
    cycle_count: "212\n",
  }), {
    percent: 64,
    state: "discharging",
    minutesRemaining: 240,
    healthPercent: 87.7,
    cycleCount: 212,
    watts: 9.5,
    temperatureC: null,
  });
});

test("reads the sensor helper's output and rejects nonsense", () => {
  assert.deepEqual(parseSensorOutput('{"cpuTempC":51.76,"gpuTempC":45.68,"cpuWatts":1.10,"gpuWatts":null}'), {
    cpuTempC: 51.76,
    gpuTempC: 45.68,
    cpuWatts: 1.1,
    gpuWatts: null,
  });
  assert.equal(parseSensorOutput("Killed: 9"), null);
  assert.equal(parseSensorOutput('{"cpuTempC":999}').cpuTempC, null);
});

test("reads GPU utilisation from ioreg", () => {
  assert.equal(parseGpuUtilization('"PerformanceStatistics" = {"Tiler Utilization %"=16,"Renderer Utilization %"=38,"Device Utilization %"=41}'), 41);
  assert.equal(parseGpuUtilization("no accelerator"), null);
});

test("the embedded helper matches its recorded digest", async () => {
  const { MAC_SENSORS_BINARY, MAC_SENSORS_DIGEST } = await import("../lib/mac-sensors-binary.ts");
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha256").update(Buffer.from(MAC_SENSORS_BINARY, "base64")).digest("hex"), MAC_SENSORS_DIGEST);
  assert.ok(readFileSync(new URL("../native/beacon-sensors.c", import.meta.url), "utf8").includes("IOReportCopyChannelsInGroup"));
});
