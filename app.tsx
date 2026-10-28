import type { ReactNode } from "react";
import { definePluginApp, experimental_Icon as Icon, type ExperimentalSidebarFooterDisclosureProps } from "@get-bb/plugin-sdk/app";
import type { Machine, ServerSnapshot } from "./server";
import { SERVER_MACHINE, useServerSnapshot } from "./hooks/use-server-snapshot";
import { machineKey, useMachines } from "./hooks/use-machines";
import { PressureNotifications, bindStatusOpener } from "./components/pressure-notifications";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
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

function ReloadButton({ onReload, reloading }: { onReload: () => void; reloading: boolean }) {
  return (
    <button type="button" className={HEADER_BUTTON_CLASS} aria-label="Reload machine status" aria-busy={reloading} disabled={reloading} onClick={onReload}>
      <Icon
        name={reloading ? "Loading" : "RotateCcw"}
        className={reloading ? "size-3.5 animate-spin motion-reduce:animate-none" : "size-3.5"}
        aria-hidden
      />
    </button>
  );
}

function CollapseButton({ onCollapse }: { onCollapse: () => void }) {
  return (
    <button type="button" className={HEADER_BUTTON_CLASS} aria-label="Hide machine status" onClick={onCollapse}>
      <Icon name="ChevronDown" className="size-3.5" aria-hidden />
    </button>
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

const MACHINE_GROUPS: { label: string; includes: (machine: Machine) => boolean }[] = [
  { label: "Machines", includes: (machine) => !machine.isBox },
  { label: "Boxes", includes: (machine) => machine.isBox },
];

function MachinePicker({ machines, selected, onSelect, trailing }: { machines: Machine[] | null; selected: string; onSelect: (machineId: string) => void; trailing: ReactNode }) {
  const options = machines ?? [];
  const known = options.some((machine) => machineKey(machine) === selected);
  return (
    <div className="sticky top-0 z-10 flex h-9 min-w-0 items-center gap-1 bg-sidebar px-1.5">
      <Select value={selected} onValueChange={onSelect} disabled={machines === null}>
        <SelectTrigger aria-label="Machine" className="h-6 w-fit min-w-0 max-w-full shrink justify-start gap-1 border-none bg-transparent px-1.5 text-xs font-medium text-sidebar-foreground shadow-none hover:bg-sidebar-accent focus:ring-0 focus-visible:ring-2 focus-visible:ring-sidebar-ring [&>svg]:size-3.5">
          <SelectValue placeholder="This bb server" />
        </SelectTrigger>
        <SelectContent>
          {known ? null : <SelectItem value={SERVER_MACHINE} className="text-xs">This bb server</SelectItem>}
          {MACHINE_GROUPS.map(({ label, includes }) => {
            const group = options.filter(includes);
            if (group.length === 0) return null;
            return (
              <SelectGroup key={label}>
                <SelectLabel>{label}</SelectLabel>
                {group.map((machine) => (
                  <SelectItem key={machine.id} value={machineKey(machine)} disabled={!machine.connected} className="text-xs">
                    {machine.name}
                    {machine.isServer ? " · server" : ""}
                  </SelectItem>
                ))}
              </SelectGroup>
            );
          })}
        </SelectContent>
      </Select>
      <span className="flex-1" />
      {trailing}
    </div>
  );
}

function StatusDisclosure({ dismiss }: ExperimentalSidebarFooterDisclosureProps) {
  const { machines, selected, setSelected } = useMachines();
  const { container, active, snapshot, error, reload, reloading } = useServerSnapshot(selected);
  return (
    <div ref={container} data-beacon-shell aria-busy={(active && !snapshot && !error) || reloading} className="w-full min-w-0 divide-y divide-sidebar-border">
      <MachinePicker
        machines={machines}
        selected={selected}
        onSelect={setSelected}
        trailing={<>
          <ReloadButton onReload={reload} reloading={reloading} />
          <CollapseButton onCollapse={dismiss} />
        </>}
      />
      {error ? <div role="alert" className="px-3 py-2 text-xs text-destructive">Could not refresh: {error}</div> : null}
      {/* The skeleton gives the shell height so the visibility observer can activate polling. */}
      {snapshot ? <StatusPopover snapshot={snapshot} isServer={selected === SERVER_MACHINE} /> : (
        error ? <div className="p-3 text-xs text-muted-foreground">Machine data unavailable. Retrying while visible.</div> : <LoadingPopover />
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "pressure-notifications", component: PressureNotifications });
  bindStatusOpener(app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "status",
    label: "Machine status",
    icon: "Laptop",
    component: StatusDisclosure,
  }).open);
});
