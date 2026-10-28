import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseLinuxBattery, parseMacBattery } from "../lib/battery.ts";
import { parseSensorOutput, startHelper } from "../lib/mac-sensors.ts";

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
    type: "Battery\n",
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

test("Linux batteries: signed current, missing capacity and peripheral batteries", () => {
  const discharging = parseLinuxBattery({
    type: "Battery", status: "Discharging", current_now: "-1000000", voltage_now: "12000000",
    charge_now: "2000000", charge_full: "4000000",
  });
  assert.equal(discharging.percent, 50, "percent comes from charge when capacity is missing");
  assert.equal(discharging.watts, 12, "a negative discharge current still gives watts");
  assert.equal(discharging.minutesRemaining, 120, "and time left");
  assert.equal(parseLinuxBattery({ type: "Battery", scope: "Device", capacity: "80" }), null, "a mouse battery is not the machine's");
  assert.equal(parseLinuxBattery({ type: "Mains", capacity: "80" }), null);
});

test("an Intel Mac's capacity in mAh becomes a percentage", () => {
  const intel = parseMacBattery(['"CurrentCapacity" = 2000', '"MaxCapacity" = 5000', '"ExternalConnected" = No'].join("\n"));
  assert.equal(intel.percent, 40);
});

test("a desktop Mac's empty battery record is no battery", () => {
  const macStudio = ['"CurrentCapacity" = 0', '"MaxCapacity" = 0', '"BatteryInstalled" = No', '"ExternalConnected" = Yes'].join("\n");
  assert.equal(parseMacBattery(macStudio), null);
});

test("reads the sensor helper's output and rejects nonsense", () => {
  assert.deepEqual(parseSensorOutput('{"cpuTempC":51.76,"gpuTempC":45.68,"cpuWatts":1.10,"gpuWatts":null,"gpuPercent":41.00}'), {
    cpuTempC: 51.76,
    gpuTempC: 45.68,
    cpuWatts: 1.1,
    gpuWatts: null,
    gpuPercent: 41,
  });
  assert.equal(parseSensorOutput('{"gpuPercent":140}').gpuPercent, null);
  assert.equal(parseSensorOutput("Killed: 9"), null);
  assert.equal(parseSensorOutput('{"cpuTempC":999}').cpuTempC, null);
});


test("the embedded helper matches its recorded digest", async () => {
  const { MAC_SENSORS_BINARY, MAC_SENSORS_DIGEST } = await import("../lib/mac-sensors-binary.ts");
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha256").update(Buffer.from(MAC_SENSORS_BINARY, "base64")).digest("hex"), MAC_SENSORS_DIGEST);
  assert.ok(readFileSync(new URL("../native/sensors.c", import.meta.url), "utf8").includes("IOReportCopyChannelsInGroup"));
});

async function fakeHelper(t, body) {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "machine-monitor-fake-helper-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "helper");
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

test("the sensor helper answers one line per request, in order", async (t) => {
  const path = await fakeHelper(t, `n=0; while read line; do n=$((n+1)); echo "{\\"cpuTempC\\":$n}"; done`);
  const helper = startHelper(path);
  t.after(() => helper.stop());
  assert.equal(await helper.request(2000), '{"cpuTempC":1}');
  assert.equal(await helper.request(2000), '{"cpuTempC":2}');
});

test("a hung, crashed or missing helper gives null and reports its exit", async (t) => {
  for (const [name, body] of [["hung", "while read line; do sleep 30; done"], ["crashed", "read line; exit 1"]]) {
    let exits = 0;
    const helper = startHelper(await fakeHelper(t, body), () => { exits += 1; });
    assert.equal(await helper.request(300), null, `${name} helper gives no reading`);
    assert.equal(await helper.request(300), null, `${name} helper is not reused`);
    assert.equal(exits, 1, `${name} helper reports one exit`);
  }
  let missingExits = 0;
  const missing = startHelper("/nonexistent/sensors", () => { missingExits += 1; });
  assert.equal(await missing.request(300), null);
  assert.equal(missingExits, 1);
});
