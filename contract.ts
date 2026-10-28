import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const percentageSchema = z.number().min(0).max(100);
const metricPointSchema = z.object({
  timestamp: z.number(),
  cpuPercent: percentageSchema.nullable(),
  memoryPercent: percentageSchema,
  networkRxBytesPerSecond: z.number().nullable(),
  networkTxBytesPerSecond: z.number().nullable(),
});
const issueSchema = z.object({
  severity: z.enum(["warning", "critical"]),
  label: z.string(),
  message: z.string(),
});
const processSchema = z.object({
  pid: z.number().int().positive(),
  name: z.string().max(128),
  cpuPercent: z.number().nonnegative(),
  memoryPercent: z.number().nonnegative(),
  rssBytes: z.number().nonnegative(),
});
export const snapshotSchema = z.object({
  timestamp: z.string(),
  refreshIntervalMs: z.number().int().min(2000).max(60_000),
  host: z.object({
    hostname: z.string(),
    platform: z.string(),
    release: z.string(),
    arch: z.string(),
    uptimeSeconds: z.number(),
  }),
  cpu: z.object({
    model: z.string(),
    cores: z.number().int().positive(),
    speedMHz: z.number().nonnegative(),
    usagePercent: percentageSchema.nullable(),
    perCoreUsagePercent: z.array(percentageSchema.nullable()),
    loadAverage: z.tuple([z.number(), z.number(), z.number()]),
  }),
  memory: z.object({
    totalBytes: z.number(),
    usedBytes: z.number(),
    freeBytes: z.number(),
    availableBytes: z.number(),
    cachedBytes: z.number(),
    buffersBytes: z.number(),
    swapTotalBytes: z.number(),
    swapUsedBytes: z.number(),
    usagePercent: percentageSchema,
  }),
  disk: z.object({
    mount: z.string(),
    totalBytes: z.number(),
    usedBytes: z.number(),
    freeBytes: z.number(),
    usagePercent: percentageSchema,
  }).nullable(),
  network: z.object({
    interface: z.string(),
    rxBytesPerSecond: z.number().nullable(),
    txBytesPerSecond: z.number().nullable(),
    rxTotalBytes: z.number(),
    txTotalBytes: z.number(),
  }).nullable(),
  tailscale: z.object({
    dnsName: z.string().max(255),
    ipv4: z.string().max(64).nullable(),
    ipv6: z.string().max(64).nullable(),
    tags: z.array(z.string().max(128)).max(16),
  }).nullable().optional(),
  processes: z.object({
    available: z.boolean(),
    total: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    top: z.array(processSchema).max(6),
  }),
  runtime: z.object({
    pid: z.number().int().positive(),
    nodeVersion: z.string(),
    processUptimeSeconds: z.number(),
    rssBytes: z.number(),
    heapUsedBytes: z.number(),
    heapTotalBytes: z.number(),
    externalBytes: z.number(),
  }),
  health: z.object({
    status: z.enum(["healthy", "warning", "critical"]),
    issues: z.array(issueSchema),
  }),
  history: z.array(metricPointSchema).max(72),
});

export type ServerSnapshot = z.infer<typeof snapshotSchema>;
export type MetricPoint = z.infer<typeof metricPointSchema>;
export type Processes = z.infer<typeof snapshotSchema>["processes"];

export const hostContract = defineRpcContract({
  machine_snapshot: {
    input: z.object({
      refreshIntervalMs: z.number().int().min(2000).max(60_000),
      force: z.boolean(),
    }),
    output: snapshotSchema,
  },
});
