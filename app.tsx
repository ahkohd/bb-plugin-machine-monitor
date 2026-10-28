import type { ReactNode } from "react";
import { definePluginApp, experimental_Icon as Icon, type ExperimentalSidebarFooterDisclosureProps } from "@get-bb/plugin-sdk/app";
import type { Machine, ServerSnapshot } from "./server";
import { SERVER_MACHINE, useServerSnapshot } from "./hooks/use-server-snapshot";
import { machineKey, useMachines } from "./hooks/use-machines";
import { PressureNotifications, bindStatusOpener } from "./components/pressure-notifications";
import { MachinePicker } from "./components/machine-picker";
import { TailscaleRows } from "./components/tailscale-section";
import { HugeiconsIcon } from "@hugeicons/react";
import { ServerIcon } from "@hugeicons/core-free-icons";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";

const GREEN = "#22c55e";
const AMBER = "#eab308";
const RED = "#ef4444";
// Compact popover: one stacked column, each metric a small row of the same shape.
const SECTION = "min-w-0 space-y-2 p-3";
const HISTORY_BARS = 36;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1));
  const precision = index < 2 ? 0 : index === 2 ? 1 : 2;
  return `${(bytes / 1024 ** index).toFixed(precision)} ${units[index]}`;
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

function formatPercent(value: number | null): ReactNode {
  return value === null ? <Sampling /> : `${value.toFixed(1)}%`;
}

function colorForPercent(value: number | null): string {
  if (value !== null && value >= 95) return RED;
  if (value !== null && value >= 75) return AMBER;
  return GREEN;
}

function Meter({ value, label }: { value: number | null; label: string }) {
  const clamped = value === null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className="relative h-2 min-w-0 w-full overflow-hidden rounded-none bg-sidebar-border" style={{ maskImage: "linear-gradient(to right, black calc(100% - 1px), transparent 0)", maskSize: "2% 100%", maskRepeat: "repeat-x" }} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined} aria-valuetext={value === null ? "Unavailable" : `${value.toFixed(1)}%`} title="Green below 75% · amber from 75% · red from 95%">
      <span aria-hidden="true" className="absolute inset-0 origin-left transition-transform duration-300 motion-reduce:transition-none" style={{ transform: `scaleX(${clamped / 100})`, backgroundColor: colorForPercent(value) }} />
    </div>
  );
}

// Recent samples as thin columns, oldest left; empty slots keep the strip from jumping.
function Bars({ values }: { values: Array<number | null> }) {
  const recent = values.slice(-HISTORY_BARS);
  const slots = [...Array.from({ length: HISTORY_BARS - recent.length }, () => null), ...recent];
  return (
    <div className="flex h-6 items-end gap-px" role="img" aria-label="CPU usage over the last few minutes" title="CPU usage, recent samples">
      {slots.map((value, index) => (
        <span key={index} className="h-full min-w-0 flex-1 origin-bottom bg-sidebar-border transition-transform duration-300 motion-reduce:transition-none" style={{ transform: `scaleY(${value === null ? 1 : Math.max(8, Math.min(100, value)) / 100})`, backgroundColor: value === null ? undefined : colorForPercent(value) }} />
      ))}
    </div>
  );
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

function Row({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs" title={title}>
      <span className="min-w-0 truncate text-muted-foreground">{label}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground">{value}</span>
    </div>
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

function StatusPopover({ snapshot, isServer }: { snapshot: ServerSnapshot; isServer: boolean }) {
  const { cpu, memory, disk, network, processes, runtime, host, history } = snapshot;
  return (
    <>
      <Section label="CPU" value={formatPercent(cpu.usagePercent)}>
        <Bars values={history.map((point) => point.cpuPercent)} />
        <div className="grid grid-cols-[repeat(auto-fill,minmax(4.25rem,1fr))] gap-x-3 gap-y-2 pt-0.5">
          {cpu.perCoreUsagePercent.map((value, index) => (
            <div key={index} className="min-w-0 space-y-1" title={`Core ${index + 1}`}>
              <div className="flex justify-between gap-1 whitespace-nowrap text-2xs tabular-nums text-muted-foreground"><span>Core {index + 1}</span><span>{value === null ? "–" : `${Math.round(value)}%`}</span></div>
              <div className="h-1 overflow-hidden rounded-full bg-sidebar-border"><div className="h-full origin-left rounded-full transition-transform duration-300 motion-reduce:transition-none" style={{ transform: `scaleX(${Math.max(0, Math.min(100, value ?? 0)) / 100})`, backgroundColor: colorForPercent(value) }} /></div>
            </div>
          ))}
        </div>
      </Section>
      <Section label="Memory" value={formatPercent(memory.usagePercent)}>
        <Meter value={memory.usagePercent} label="Memory usage" />
        <Row label="Used" value={`${formatBytes(memory.usedBytes)} of ${formatBytes(memory.totalBytes)}`} />
        {memory.swapTotalBytes > 0 ? <Row label="Swap" value={`${formatBytes(memory.swapUsedBytes)} of ${formatBytes(memory.swapTotalBytes)}`} /> : null}
      </Section>
      <Section label="Disk" value={disk ? formatPercent(disk.usagePercent) : "Unavailable"}>
        {disk ? <>
          <Meter value={disk.usagePercent} label="Disk usage" />
          <Row label="Free" value={`${formatBytes(disk.freeBytes)} of ${formatBytes(disk.totalBytes)}`} />
        </> : null}
      </Section>
      <Section label="Network" value={network ? undefined : "Unavailable"}>
        {network ? <>
          <Row label="Download" value={formatRate(network.rxBytesPerSecond)} />
          <Row label="Upload" value={formatRate(network.txBytesPerSecond)} />
        </> : null}
      </Section>
      {snapshot.tailscale ? (
        <Section label="Tailscale">
          <TailscaleRows tailscale={snapshot.tailscale} />
        </Section>
      ) : null}
      <Section label="Top processes" value={processes.available ? `${processes.total} total` : "Unavailable"}>
        {processes.top.slice(0, 3).map((process) => (
          <Row key={process.pid} label={process.name} value={formatBytes(process.rssBytes)} title={`PID ${process.pid} · ${process.cpuPercent.toFixed(1)}% CPU average · ${formatBytes(process.rssBytes)} memory`} />
        ))}
      </Section>
      <Section label="Uptime">
        <Row label={isServer ? "Server" : "Machine"} value={formatDuration(host.uptimeSeconds)} />
        {isServer ? <Row label="bb" value={formatDuration(runtime.processUptimeSeconds)} /> : null}
      </Section>
      <Section ariaLabel="Snapshot update" label={<time dateTime={snapshot.timestamp}>{formatUpdatedAt(snapshot.timestamp)}</time>} />
    </>
  );
}

// Initial placeholders only. Core count and optional rows are unknown until loaded.
const LOADING_SECTIONS = [["CPU", "h-24"], ["Memory", "h-8"], ["Disk", "h-8"], ["Network", "h-10"], ["Top processes", "h-16"], ["Uptime", "h-10"]] as const;

function LoadingPopover() {
  return (
    <>
      {LOADING_SECTIONS.map(([label, height]) => (
        <Section key={label} label={label}><Skeleton className={`${height} w-full`} /></Section>
      ))}
      <Section label={<Skeleton className="h-3 w-24" />} />
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
