import { test } from "node:test";
import assert from "node:assert/strict";
import { createTailscaleReader, parseTailscaleStatus } from "../lib/tailscale.ts";

const running = (self) => JSON.stringify({ BackendState: "Running", Self: self, Peer: { a: { DNSName: "peer.example.ts.net." } } });

test("reads this machine's name, addresses and tags, not its peers", () => {
  assert.deepEqual(
    parseTailscaleStatus(running({ DNSName: "studio.example-net.ts.net.", TailscaleIPs: ["100.64.0.7", "fd7a:115c:a1e0::7"], Tags: ["tag:server"] })),
    { dnsName: "studio.example-net.ts.net", ipv4: "100.64.0.7", ipv6: "fd7a:115c:a1e0::7", tags: ["tag:server"] },
  );
});

test("treats missing tags and IPv6 as empty", () => {
  assert.deepEqual(
    parseTailscaleStatus(running({ DNSName: "laptop.example-net.ts.net.", TailscaleIPs: ["100.64.0.8"], Tags: null })),
    { dnsName: "laptop.example-net.ts.net", ipv4: "100.64.0.8", ipv6: null, tags: [] },
  );
});

test("shows nothing when Tailscale is stopped, logged out or the output is not JSON", () => {
  assert.equal(parseTailscaleStatus(JSON.stringify({ BackendState: "Stopped", Self: { DNSName: "x.ts.net." } })), null);
  assert.equal(parseTailscaleStatus(JSON.stringify({ BackendState: "NeedsLogin" })), null);
  assert.equal(parseTailscaleStatus("failed to connect to local tailscaled"), null);
  assert.equal(parseTailscaleStatus(running({ DNSName: "" })), null);
});

test("the reader reuses one reading for a minute", async () => {
  let clock = 0;
  const read = createTailscaleReader(() => clock);
  const signal = new AbortController().signal;
  const first = await read(signal);
  clock = 30_000;
  assert.equal(await read(signal), first);
});
