import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { parseNetstatLinks, parseWindowsSubinterfaces } from "../server.ts";
import hostEntry from "../host.ts";

const SERVER_HOST = "host_server";

const hosts = [
  makeHostResponse({ id: "host_box", name: "glad-coral", status: "connected", machineProviderId: "bb-box" }),
  makeHostResponse({ id: "host_mac", name: "mbp", status: "connected", machineProviderId: "manual" }),
  makeHostResponse({ id: SERVER_HOST, name: "bb", status: "connected", machineProviderId: null }),
  makeHostResponse({ id: "host_gone", name: "old-laptop", status: "disconnected", machineProviderId: "manual" }),
  makeHostResponse({ id: "host_agent", name: "agentctl", status: "connected", machineProviderId: "manual" }),
];

async function startPlugin(t, callHostRpc) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "machine-status",
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
  const harness = await startPlugin(t);
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
  const harness = await startPlugin(t, async () => ({ ...remote, host: { ...remote.host, hostname: "mbp-host" } }));
  const snapshot = await harness.behavior.callRpc("machine_snapshot", { hostId: "host_mac", force: true });
  assert.equal(snapshot.host.hostname, "mbp-host");
  assert.deepEqual(
    harness.inspection.experimental_hostRpcCalls.map(({ method, hostId, input }) => ({ method, hostId, input })),
    [{ method: "machine_snapshot", hostId: "host_mac", input: { refreshIntervalMs: 5000, force: true } }],
  );
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

test("looks up the bb server's host id once, not on every poll", async (t) => {
  const remote = await hostEntry.handlers.machine_snapshot({ refreshIntervalMs: 5000, force: true }, {});
  const harness = await startPlugin(t, async () => remote);
  await harness.behavior.callRpc("machines_list", null);
  for (let i = 0; i < 5; i++) {
    await harness.behavior.callRpc("machine_snapshot", { hostId: "host_mac", force: false });
  }
  await harness.behavior.callRpc("machines_list", null);
  assert.equal(harness.inspection.sdk.callsTo("system.config").length, 1);
});

test("a remote machine reports the new refresh interval even from its cache", async () => {
  await hostEntry.handlers.machine_snapshot({ refreshIntervalMs: 5000, force: true }, {});
  const cached = await hostEntry.handlers.machine_snapshot({ refreshIntervalMs: 60_000, force: false }, {});
  assert.equal(cached.refreshIntervalMs, 60_000);
});

test("WSL reads Windows' 64-bit network totals from netsh subinterfaces", () => {
  const output = [
    "",
    "       MTU  MediaSenseState      Bytes In     Bytes Out  Interface",
    "----------  ---------------  ------------  ------------  -------------",
    "4294967295                1             0          1400  Loopback Pseudo-Interface 1",
    "      1500                1    5062009579      33495802  Ethernet",
    "      1500                1        120000          8000  vEthernet (WSL)",
  ].join("\r\n");
  assert.deepEqual(parseWindowsSubinterfaces(output), { interface: "Windows", rxBytes: 5062129579, txBytes: 33503802 }, "64-bit totals past 4 GiB, summed without loopback");
  const german = output.replace("Bytes In     Bytes Out  Interface", "Bytes ein    Bytes aus  Schnittstelle");
  assert.equal(parseWindowsSubinterfaces(german)?.rxBytes, 5062129579, "rows are found without the English header");
  assert.equal(parseWindowsSubinterfaces("The system cannot find the path specified."), null);
});

test("load errors read as plain messages without transport details", async () => {
  const { loadErrorCopy } = await import("../lib/load-error-copy.ts");
  assert.equal(loadErrorCopy('rpc "machine_snapshot" failed (HTTP 502)', "lively-summit"), "Can't reach lively-summit.");
  assert.equal(loadErrorCopy("Host request timed out", "mbp"), "Can't reach mbp.");
  assert.equal(loadErrorCopy("Unexpected snapshot shape", "mbp"), "Couldn't get stats from mbp.");
});

test("the remembered panel layout survives bad storage and clamps tailscale rows", async () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  try {
    const { readPanelShape, rememberPanelShape } = await import("../lib/panel-shape.ts");
    assert.deepEqual(readPanelShape("host_mac"), { gpu: false, battery: false, tailscaleRows: 0 });
    rememberPanelShape("host_mac", { gpu: true, battery: true, tailscaleRows: 3 });
    assert.deepEqual(readPanelShape("host_mac"), { gpu: true, battery: true, tailscaleRows: 3 });
    store.set("machine-status:shape:host_box", JSON.stringify({ gpu: "yes", tailscaleRows: 40 }));
    assert.deepEqual(readPanelShape("host_box"), { gpu: false, battery: false, tailscaleRows: 4 });
    store.set("machine-status:shape:host_box", "{not json");
    assert.deepEqual(readPanelShape("host_box"), { gpu: false, battery: false, tailscaleRows: 0 });
  } finally {
    delete globalThis.localStorage;
  }
});

test("settings stored under the old Beacon names move to the new names once", async () => {
  const { moveLegacyStorage } = await import("../lib/legacy-storage.ts");
  const store = new Map([
    ["beacon:machine", "host_mac"],
    ["beacon:ip-version", "IPv6"],
    ["beacon:shape:host_mac", '{"gpu":true}'],
    ["machine-status:ip-version", "IPv4"],
    ["other-plugin:key", "untouched"],
  ]);
  const storage = {
    get length() { return store.size; },
    key: (index) => [...store.keys()][index] ?? null,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
  moveLegacyStorage(storage);
  assert.deepEqual(Object.fromEntries(store), {
    "machine-status:machine": "host_mac",
    "machine-status:ip-version": "IPv4",
    "machine-status:shape:host_mac": '{"gpu":true}',
    "other-plugin:key": "untouched",
  }, "old keys move, newer values win and other keys stay");
});
