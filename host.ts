import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.ts";
import { createCollector } from "./lib/collector.ts";
import { createDemandSampler } from "./lib/demand-sampler.ts";

let refreshIntervalMs = 5000;
const collector = createCollector(() => refreshIntervalMs);
const sampler = createDemandSampler({
  collect: collector.collect,
  intervalMs: () => refreshIntervalMs,
  reset: collector.reset,
});

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    machine_snapshot: async ({ refreshIntervalMs: requested, force }) => {
      refreshIntervalMs = requested;
      return { ...(await sampler.sample(force)), refreshIntervalMs };
    },
  },
  dispose: () => sampler.dispose(),
});
