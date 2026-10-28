import type { ReactNode } from "react";
import { definePluginApp, experimental_Icon as Icon, type ExperimentalSidebarFooterDisclosureProps } from "@get-bb/plugin-sdk/app";
import type { Machine, ServerSnapshot } from "./server";
import { SERVER_MACHINE, useServerSnapshot } from "./hooks/use-server-snapshot";
import { machineKey, useMachines } from "./hooks/use-machines";
import { PressureNotifications, bindStatusOpener } from "./components/pressure-notifications";
import { MachinePicker } from "./components/machine-picker";
import { TailscaleRows } from "./components/tailscale-section";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDataTransferVerticalIcon, BatteryChargingIcon, BatteryFullIcon, CpuIcon, GpuIcon, HardDriveIcon, RamMemoryIcon, ServerIcon } from "@hugeicons/core-free-icons";
import { BarChart, BigValue, DetailRow, Footnote, LineChart, METRIC_COLORS, MetricSection, Pill, ProgressBar } from "./components/metric-parts";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";

const GREEN = "#22c55e";
const AMBER = "#eab308";
const RED = "#ef4444";
// Compact popover: one stacked column, each metric a small row of the same shape.
const SECTION = "min-w-0 space-y-2 p-3";
const HISTORY_BARS = 24;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1));
  const value = bytes / 1024 ** index;
  const precision = index < 2 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(precision))} ${units[index]}`;
}

// The first reading of rate-based counters needs a second sample.
function Sampling() {
  return <span className="inline-block min-w-10 text-right" aria-label="Sampling" title="Waiting for a second sample">–</span>;
}

function formatRate(bytes: number | null): ReactNode {
  return bytes === null ? <Sampling /> : `${formatBytes(bytes)}/s`;
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Updated recently";
  return `Updated at ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date)}`;
}


function colorForPercent(value: number | null): string {
  if (value !== null && value >= 95) return RED;
  if (value !== null && value >= 75) return AMBER;
  return GREEN;
}



// Every section shares one header shape: name left, headline value right.
function Section({ label, value, children, ariaLabel }: { label: ReactNode; value?: ReactNode; children?: ReactNode; ariaLabel?: string }) {
  return (
    <section className={SECTION} aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-sidebar-foreground">{label}</span>
        {value === undefined ? null : <span className="shrink-0 tabular-nums text-sidebar-foreground">{value}</span>}
      </div>
      {children}
    </section>
  );
}


const HEADER_BUTTON_CLASS = "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:opacity-50";

function HeaderButton({ label, tooltip, onClick, disabled, busy, children }: { label: string; tooltip: ReactNode; onClick: () => void; disabled?: boolean; busy?: boolean; children: ReactNode }) {
  return (
    <Tooltip delayDuration={350} disableHoverableContent>
      <TooltipTrigger asChild>
        <button type="button" className={HEADER_BUTTON_CLASS} aria-label={label} aria-busy={busy} disabled={disabled} onClick={onClick}>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function ReloadButton({ onReload, reloading, updatedAt }: { onReload: () => void; reloading: boolean; updatedAt: string | null }) {
  return (
    <HeaderButton
      label="Reload machine status"
      tooltip={reloading ? "Reloading" : updatedAt ? `${formatUpdatedAt(updatedAt)} · Reload` : "Reload"}
      onClick={onReload}
      disabled={reloading}
      busy={reloading}
    >
      <Icon
        name={reloading ? "Loading" : "RotateCcw"}
        className={reloading ? "size-3.5 animate-spin motion-reduce:animate-none" : "size-3.5"}
        aria-hidden
      />
    </HeaderButton>
  );
}

function CollapseButton({ onCollapse }: { onCollapse: () => void }) {
  return (
    <HeaderButton label="Hide machine status" tooltip="Hide" onClick={onCollapse}>
      <Icon name="ChevronDown" className="size-4" aria-hidden />
    </HeaderButton>
  );
}

const SECTION_ICON_CLASS = "size-3.5 opacity-90";

function SectionIcon({ icon, color }: { icon: Parameters<typeof HugeiconsIcon>[0]["icon"]; color: string }) {
  return <HugeiconsIcon icon={icon} className={SECTION_ICON_CLASS} style={{ color }} aria-hidden="true" />;
}

function temperatureTone(celsius: number): "neutral" | "warn" | "bad" {
  if (celsius >= 95) return "bad";
  return celsius >= 80 ? "warn" : "neutral";
}

function TemperaturePill({ celsius }: { celsius: number }) {
  return <Pill tone={temperatureTone(celsius)}>{Math.round(celsius)}°C</Pill>;
}

function formatWatts(watts: number | null | undefined): string | null {
  if (watts === null || watts === undefined) return null;
  return `${watts < 10 ? watts.toFixed(1) : Math.round(watts)}W`;
}

function formatMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

function joinParts(parts: Array<string | null | false | undefined>): string {
  return parts.filter(Boolean).join(" · ");
}

function bytesParts(bytes: number): { value: string; unit: string } {
  const [value, unit] = formatBytes(bytes).split(" ");
  return { value: value ?? "0", unit: unit ?? "B" };
}

function cpuState(percent: number | null): string {
  if (percent === null) return "sampling";
  if (percent < 25) return "idle";
  if (percent < 75) return "normal";
  return "busy";
}

function memoryPressure(percent: number): { label: string; tone: "neutral" | "warn" | "bad" } {
  if (percent >= 95) return { label: "Critical", tone: "bad" };
  if (percent >= 85) return { label: "High", tone: "warn" };
  return { label: "Normal", tone: "neutral" };
}

const PLATFORM_NAMES: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

const HEALTH_LABELS = {
  healthy: { label: "Healthy", tone: "good", color: METRIC_COLORS.good },
  warning: { label: "Warning", tone: "warn", color: METRIC_COLORS.warn },
  critical: { label: "Critical", tone: "bad", color: METRIC_COLORS.bad },
} as const;

function SummaryStrip({ snapshot, isServer }: { snapshot: ServerSnapshot; isServer: boolean }) {
  const { host, memory, cpu, health, runtime } = snapshot;
  const status = HEALTH_LABELS[health.status];
  const healthPill = (
    <Pill tone={status.tone === "good" ? "neutral" : status.tone}>
      <span className="size-1.5 rounded-full" style={{ backgroundColor: status.color }} />
      {status.label}
    </Pill>
  );
  return (
    <div className="flex flex-wrap items-center gap-1 px-3 py-2">
      {health.issues.length > 0 ? (
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild><span tabIndex={0} className="inline-flex outline-none">{healthPill}</span></TooltipTrigger>
          <TooltipContent side="right" align="start" className="max-w-64 space-y-1 text-xs">
            {health.issues.map((issue) => <p key={issue.label}>{issue.message}</p>)}
          </TooltipContent>
        </Tooltip>
      ) : healthPill}
      <Pill>{PLATFORM_NAMES[host.platform] ?? host.platform} · {host.arch}</Pill>
      <Pill>{formatBytes(memory.totalBytes)}</Pill>
      <Pill>{cpu.cores} cores</Pill>
      <Pill>up {formatDuration(host.uptimeSeconds)}</Pill>
      {isServer ? <Pill>bb up {formatDuration(runtime.processUptimeSeconds)}</Pill> : null}
    </div>
  );
}

function CpuSection({ snapshot }: { snapshot: ServerSnapshot }) {
  const { cpu, history, sensors } = snapshot;
  const temperature = sensors?.cpuTempC ?? null;
  return (
    <MetricSection
      label="CPU"
      icon={<SectionIcon icon={CpuIcon} color={METRIC_COLORS.good} />}
      pill={temperature === null ? <Pill>load {cpu.loadAverage[0].toFixed(2)}</Pill> : <TemperaturePill celsius={temperature} />}
      details={<>
        <p className="font-medium">{cpu.model}</p>
        <DetailRow label="Cores" value={cpu.cores} />
        {cpu.speedMHz > 0 ? <DetailRow label="Speed" value={`${(cpu.speedMHz / 1000).toFixed(2)} GHz`} /> : null}
        <DetailRow label="Load 1 · 5 · 15 min" value={cpu.loadAverage.map((value) => value.toFixed(2)).join(" · ")} />
        {temperature !== null ? <DetailRow label="Temperature" value={`${temperature.toFixed(1)}°C`} /> : null}
        {sensors?.cpuWatts != null ? <DetailRow label="Power" value={formatWatts(sensors.cpuWatts)} /> : null}
        <div className="grid grid-cols-4 gap-x-3 gap-y-1 pt-1">
          {cpu.perCoreUsagePercent.map((value, index) => (
            <div key={index} className="space-y-0.5">
              <div className="flex justify-between gap-1 text-2xs tabular-nums opacity-80"><span>{index + 1}</span><span>{value === null ? "–" : `${Math.round(value)}%`}</span></div>
              <div className="h-1 overflow-hidden rounded-full bg-primary-foreground/20"><div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%`, backgroundColor: colorForPercent(value) }} /></div>
            </div>
          ))}
        </div>
      </>}
    >
      <BigValue value={cpu.usagePercent === null ? "–" : Math.round(cpu.usagePercent)} unit="%" />
      <BarChart values={history.map((point) => point.cpuPercent)} colorFor={colorForPercent} label="CPU usage over the last few minutes" slots={HISTORY_BARS} />
      <Footnote>{joinParts([cpuState(cpu.usagePercent), formatWatts(sensors?.cpuWatts) ?? `${cpu.cores} cores`])}</Footnote>
    </MetricSection>
  );
}

function MemorySection({ snapshot }: { snapshot: ServerSnapshot }) {
  const { memory, history } = snapshot;
  const pressure = memoryPressure(memory.usagePercent);
  return (
    <MetricSection
      label="Memory"
      icon={<SectionIcon icon={RamMemoryIcon} color={METRIC_COLORS.memory} />}
      pill={<Pill tone={pressure.tone}>{pressure.label}</Pill>}
      details={<>
        <DetailRow label="Used" value={formatBytes(memory.usedBytes)} />
        <DetailRow label="Available" value={formatBytes(memory.availableBytes)} />
        {memory.cachedBytes > 0 ? <DetailRow label="Cached" value={formatBytes(memory.cachedBytes)} /> : null}
        {memory.swapTotalBytes > 0 ? <DetailRow label="Swap" value={`${formatBytes(memory.swapUsedBytes)} of ${formatBytes(memory.swapTotalBytes)}`} /> : null}
      </>}
    >
      <BigValue value={Math.round(memory.usagePercent)} unit="%" />
      <LineChart series={[{ values: history.map((point) => point.memoryPercent), color: METRIC_COLORS.memory }]} max={100} label="Memory usage over the last few minutes" />
      <Footnote>{formatBytes(memory.usedBytes)} / {formatBytes(memory.totalBytes)}</Footnote>
    </MetricSection>
  );
}

function DiskSection({ snapshot }: { snapshot: ServerSnapshot }) {
  const { disk } = snapshot;
  if (!disk) {
    return <MetricSection label="Free space" icon={<SectionIcon icon={HardDriveIcon} color={METRIC_COLORS.disk} />} pill={<Pill>Unavailable</Pill>}><Footnote>Disk usage could not be read.</Footnote></MetricSection>;
  }
  const free = bytesParts(disk.freeBytes);
  return (
    <MetricSection
      label="Free space"
      icon={<SectionIcon icon={HardDriveIcon} color={METRIC_COLORS.disk} />}
      pill={<Pill>{formatBytes(disk.totalBytes)}</Pill>}
      details={<>
        <DetailRow label="Mount" value={disk.mount} />
        <DetailRow label="Used" value={formatBytes(disk.usedBytes)} />
        <DetailRow label="Free" value={formatBytes(disk.freeBytes)} />
      </>}
    >
      <BigValue value={free.value} unit={free.unit} />
      <ProgressBar value={disk.usagePercent} color={disk.usagePercent >= 95 ? METRIC_COLORS.bad : disk.usagePercent >= 85 ? METRIC_COLORS.warn : METRIC_COLORS.disk} label="Disk usage" />
      <Footnote>{formatBytes(disk.usedBytes)} used · {Math.round(disk.usagePercent)}%</Footnote>
    </MetricSection>
  );
}

function NetworkSection({ snapshot }: { snapshot: ServerSnapshot }) {
  const { network, history } = snapshot;
  if (!network) {
    return <MetricSection label="Network" icon={<SectionIcon icon={ArrowDataTransferVerticalIcon} color={METRIC_COLORS.download} />} pill={<Pill>Unavailable</Pill>}><Footnote>Network counters could not be read.</Footnote></MetricSection>;
  }
  const down = network.rxBytesPerSecond === null ? null : bytesParts(network.rxBytesPerSecond);
  return (
    <MetricSection
      label="Network"
      icon={<SectionIcon icon={ArrowDataTransferVerticalIcon} color={METRIC_COLORS.download} />}
      pill={<Pill>{network.interface}</Pill>}
      details={<>
        <DetailRow label="Download" value={formatRate(network.rxBytesPerSecond)} />
        <DetailRow label="Upload" value={formatRate(network.txBytesPerSecond)} />
        <DetailRow label="Received" value={formatBytes(network.rxTotalBytes)} />
        <DetailRow label="Sent" value={formatBytes(network.txTotalBytes)} />
      </>}
    >
      <BigValue value={down ? down.value : "–"} unit={down ? `${down.unit}/s down` : undefined} />
      <LineChart
        series={[
          { values: history.map((point) => point.networkRxBytesPerSecond), color: METRIC_COLORS.download },
          { values: history.map((point) => point.networkTxBytesPerSecond), color: METRIC_COLORS.upload },
        ]}
        label="Download and upload over the last few minutes"
      />
      <Footnote>
        <span style={{ color: METRIC_COLORS.upload }}>●</span> {formatRate(network.txBytesPerSecond)} up
      </Footnote>
    </MetricSection>
  );
}

function GpuSection({ snapshot }: { snapshot: ServerSnapshot }) {
  const { sensors, history } = snapshot;
  if (!sensors || (sensors.gpuPercent === null && sensors.gpuTempC === null)) return null;
  return (
    <MetricSection
      label="GPU"
      icon={<SectionIcon icon={GpuIcon} color={METRIC_COLORS.gpu} />}
      pill={sensors.gpuTempC === null ? undefined : <TemperaturePill celsius={sensors.gpuTempC} />}
      details={<>
        {sensors.gpuPercent !== null ? <DetailRow label="Usage" value={`${sensors.gpuPercent}%`} /> : null}
        {sensors.gpuTempC !== null ? <DetailRow label="Temperature" value={`${sensors.gpuTempC.toFixed(1)}°C`} /> : null}
        {sensors.gpuWatts !== null ? <DetailRow label="Power" value={formatWatts(sensors.gpuWatts)} /> : null}
      </>}
    >
      <BigValue value={sensors.gpuPercent ?? "–"} unit="%" />
      <LineChart series={[{ values: history.map((point) => point.gpuPercent ?? null), color: METRIC_COLORS.gpu }]} max={100} label="GPU usage over the last few minutes" />
      <Footnote>{joinParts([cpuState(sensors.gpuPercent), formatWatts(sensors.gpuWatts)])}</Footnote>
    </MetricSection>
  );
}

const BATTERY_STATES = {
  charging: "Charging",
  discharging: "On battery",
  full: "Fully charged",
  "plugged-in": "Plugged in",
} as const;

function batteryColor(percent: number, charging: boolean): string {
  if (charging || percent > 40) return METRIC_COLORS.good;
  return percent > 15 ? METRIC_COLORS.warn : METRIC_COLORS.bad;
}

function BatterySection({ snapshot }: { snapshot: ServerSnapshot }) {
  const { battery } = snapshot;
  if (!battery) return null;
  const timeLeft = battery.minutesRemaining === null
    ? null
    : battery.state === "charging"
      ? `${formatMinutes(battery.minutesRemaining)} to full`
      : `${formatMinutes(battery.minutesRemaining)} left`;
  return (
    <MetricSection
      label="Battery"
      icon={<SectionIcon icon={battery.state === "charging" ? BatteryChargingIcon : BatteryFullIcon} color={batteryColor(battery.percent, battery.state === "charging")} />}
      pill={battery.healthPercent === null ? undefined : <Pill>{Math.round(battery.healthPercent)}% health</Pill>}
      details={<>
        <DetailRow label="State" value={BATTERY_STATES[battery.state]} />
        {battery.cycleCount !== null ? <DetailRow label="Cycles" value={battery.cycleCount} /> : null}
        {battery.temperatureC !== null ? <DetailRow label="Temperature" value={`${battery.temperatureC.toFixed(1)}°C`} /> : null}
        {battery.watts !== null ? <DetailRow label={battery.state === "charging" ? "Charging power" : "Power draw"} value={formatWatts(battery.watts)} /> : null}
      </>}
    >
      <BigValue value={Math.round(battery.percent)} unit="%" />
      <ProgressBar value={battery.percent} color={batteryColor(battery.percent, battery.state === "charging")} label="Battery charge" />
      <Footnote>{joinParts([BATTERY_STATES[battery.state], battery.state === "charging" || battery.state === "discharging" ? formatWatts(battery.watts) : null, timeLeft])}</Footnote>
    </MetricSection>
  );
}

function ProcessesSection({ snapshot }: { snapshot: ServerSnapshot }) {
  const { processes } = snapshot;
  return (
    <section aria-label="Top processes" className="min-w-0 p-3">
      <div className="grid grid-cols-[1fr_auto_3rem] items-center gap-x-3 gap-y-1.5 text-xs">
        <span className="font-medium text-sidebar-foreground">Top processes</span>
        <span className="text-right text-subtle-foreground">Memory</span>
        <span className="text-right text-subtle-foreground">% CPU</span>
        {processes.available ? processes.top.slice(0, 5).map((process) => (
          <div key={process.pid} className="contents">
            <Tooltip delayDuration={400}>
              <TooltipTrigger asChild>
                <span className="min-w-0 truncate text-sidebar-foreground">{process.name}</span>
              </TooltipTrigger>
              <TooltipContent side="right" className="text-xs">{process.name} · PID {process.pid}</TooltipContent>
            </Tooltip>
            <span className="text-right tabular-nums text-sidebar-foreground">{formatBytes(process.rssBytes)}</span>
            <span className="text-right tabular-nums text-sidebar-foreground" style={{ color: process.cpuPercent >= 50 ? METRIC_COLORS.warnDim : undefined }}>{process.cpuPercent.toFixed(1)}</span>
          </div>
        )) : <span className="col-span-3 text-muted-foreground">Unavailable</span>}
      </div>
    </section>
  );
}

function StatusPopover({ snapshot, isServer }: { snapshot: ServerSnapshot; isServer: boolean }) {
  return (
    <>
      <SummaryStrip snapshot={snapshot} isServer={isServer} />
      <CpuSection snapshot={snapshot} />
      <GpuSection snapshot={snapshot} />
      <MemorySection snapshot={snapshot} />
      <DiskSection snapshot={snapshot} />
      <NetworkSection snapshot={snapshot} />
      <BatterySection snapshot={snapshot} />
      {snapshot.tailscale ? (
        <Section label="Tailscale">
          <TailscaleRows tailscale={snapshot.tailscale} />
        </Section>
      ) : null}
      <ProcessesSection snapshot={snapshot} />
    </>
  );
}

// Initial placeholders only. Core count and optional rows are unknown until loaded.
const LOADING_SECTIONS = [["CPU", "h-20"], ["Memory", "h-20"], ["Free space", "h-16"], ["Network", "h-20"], ["Top processes", "h-24"]] as const;

function LoadingPopover() {
  return (
    <>
      {LOADING_SECTIONS.map(([label, height]) => (
        <Section key={label} label={label}><Skeleton className={`${height} w-full`} /></Section>
      ))}
    </>
  );
}

function MachineHeader({ machines, selected, onSelect, onOpen, actions }: { machines: Machine[] | null; selected: string; onSelect: (machineId: string) => void; onOpen: () => void; actions: ReactNode }) {
  return (
    <div className="sticky top-0 z-10 bg-sidebar">
      <div className="flex h-9 min-w-0 items-center gap-1 bg-sidebar-accent/50 px-1.5">
        <MachinePicker machines={machines} selected={selected} onSelect={onSelect} onOpen={onOpen} />
        <span className="flex-1" />
        {actions}
      </div>
    </div>
  );
}

function ServerMark({ className }: { className?: string }) {
  return <HugeiconsIcon icon={ServerIcon} className={className} aria-hidden="true" />;
}

function StatusDisclosure({ dismiss }: ExperimentalSidebarFooterDisclosureProps) {
  const { machines, selected, setSelected, refresh: refreshMachines } = useMachines();
  const { container, active, snapshot, error, reload, reloading } = useServerSnapshot(selected);
  return (
    <TooltipProvider>
    <div ref={container} data-beacon-shell aria-busy={(active && !snapshot && !error) || reloading} className="w-full min-w-0 divide-y divide-sidebar-border">
      <MachineHeader
        machines={machines}
        selected={selected}
        onSelect={setSelected}
        onOpen={() => void refreshMachines()}
        actions={<>
          <ReloadButton onReload={reload} reloading={reloading} updatedAt={snapshot?.timestamp ?? null} />
          <CollapseButton onCollapse={dismiss} />
        </>}
      />
      {error ? <div role="alert" className="px-3 py-2 text-xs text-destructive">Could not refresh: {error}</div> : null}
      {/* The skeleton gives the shell height so the visibility observer can activate polling. */}
      {snapshot ? <StatusPopover snapshot={snapshot} isServer={selected === SERVER_MACHINE} /> : (
        error ? <div className="p-3 text-xs text-muted-foreground">Machine data unavailable. Retrying while visible.</div> : <LoadingPopover />
      )}
    </div>
    </TooltipProvider>
  );
}

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: "Server", component: ServerMark });
  app.slots.experimental_appOverlay({ id: "pressure-notifications", component: PressureNotifications });
  bindStatusOpener(app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "status",
    label: "Machine status",
    icon: "Server",
    component: StatusDisclosure,
  }).open);
});
