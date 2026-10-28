import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { parseNetstatLinks } from "../server.ts";
import hostEntry from "../host.ts";

const SERVER_HOST = "host_server";

const hosts = [
  makeHostResponse({ id: "host_box", name: "glad-coral", status: "connected", machineProviderId: "bb-box" }),
  makeHostResponse({ id: "host_mac", name: "mbp", status: "connected", machineProviderId: "manual" }),
  makeHostResponse({ id: SERVER_HOST, name: "bb", status: "connected", machineProviderId: null }),
  makeHostResponse({ id: "host_gone", name: "old-laptop", status: "disconnected", machineProviderId: "manual" }),
  makeHostResponse({ id: "host_agent", name: "agentctl", status: "connected", machineProviderId: "manual" }),
];

async function startBeacon(t, callHostRpc) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "beacon",
    sdk: {
      hosts: { list: async () => hosts },
      system: { config: async () => ({ primaryHostId: SERVER_HOST }) },
    },
    experimental_callHostRpc: callHostRpc,
  });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  return harness;
}

test("lists the server first, then own machines, then boxes, and hides offline machines", async (t) => {
  const harness = await startBeacon(t);
  const { machines } = await harness.behavior.callRpc("machines_list", null);
  assert.deepEqual(
    machines.map(({ name, isServer, isBox }) => ({ name, isServer, isBox })),
    [
      { name: "bb", isServer: true, isBox: false },
      { name: "agentctl", isServer: false, isBox: false },
      { name: "mbp", isServer: false, isBox: false },
      { name: "glad-coral", isServer: false, isBox: true },
    ],
  );
});

test("reads another machine through its host entry with the current refresh interval", async (t) => {
  const remote = await hostEntry.handlers.machine_snapshot({ refreshIntervalMs: 5000, force: true }, {});
  const harness = await startBeacon(t, async () => ({ ...remote, host: { ...remote.host, hostname: "mbp-host" } }));
  const snapshot = await harness.behavior.callRpc("machine_snapshot", { hostId: "host_mac", force: true });
  assert.equal(snapshot.host.hostname, "mbp-host");
  assert.deepEqual(
    harness.inspection.experimental_hostRpcCalls.map(({ method, hostId, input }) => ({ method, hostId, input })),
    [{ method: "machine_snapshot", hostId: "host_mac", input: { refreshIntervalMs: 5000, force: true } }],
  );
});

test("reads the bb server directly without a host call", async (t) => {
  const harness = await startBeacon(t, async () => { throw new Error("should not be called"); });
  const snapshot = await harness.behavior.callRpc("machine_snapshot", { hostId: SERVER_HOST, force: false });
  assert.ok(snapshot.cpu.cores > 0);
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, 0);
});

test("the host entry returns a valid snapshot and keeps CPU history between calls", async () => {
  const first = await hostEntry.handlers.machine_snapshot({ refreshIntervalMs: 5000, force: true }, {});
  const second = await hostEntry.handlers.machine_snapshot({ refreshIntervalMs: 5000, force: true }, {});
  assert.equal(first.refreshIntervalMs, 5000);
  assert.ok(second.history.length >= 2);
  assert.ok(second.cpu.cores > 0);
});

test("macOS netstat parsing picks the busiest link and skips loopback and per-address rows", () => {
  const source = [
    "Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll",
    "lo0        16384 <Link#1>                      101130111     0 183408246752 101130111     0 183408246752     0",
    "lo0        16384 127           127.0.0.1       101130111     - 183408246752 101130111     - 183408246752     -",
    "gif0*      1280  <Link#2>                             0     0          0        0     0          0     0",
    "en0        1500  <Link#11>   a0:b1:c2:d3:e4:f5  9000000     0  8000000000  7000000     0  2000000000     0",
    "en0        1500  192.168.1     192.168.1.20     9000000     -  8000000000  7000000     -  2000000000     -",
    "utun3      1380  <Link#20>                       5000     0     400000     6000     0     500000     0",
  ].join("\n");
  assert.deepEqual(parseNetstatLinks(source), { interface: "en0", rxBytes: 8000000000, txBytes: 2000000000 });
  assert.equal(parseNetstatLinks("Name Mtu Network Address\n"), null);
});
