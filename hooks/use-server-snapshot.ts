import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, ServerSnapshot } from "../server";
import { createSnapshotSource } from "../lib/snapshot-source.ts";
import { createVisiblePoller } from "../lib/visible-poller.ts";

type SnapshotSource = ReturnType<typeof createSnapshotSource<ServerSnapshot>>;

// One bounded snapshot per machine per app bundle, never keyed by thread.
// Survives disclosure remounts without timers and is released with the bundle.
const sources = new Map<string, SnapshotSource>();

const MAX_REMEMBERED_MACHINES = 8;

function sourceFor(machineKey: string): SnapshotSource {
  const source = sources.get(machineKey) ?? createSnapshotSource<ServerSnapshot>((value) => value.refreshIntervalMs);
  sources.delete(machineKey);
  sources.set(machineKey, source);
  for (const oldest of sources.keys()) {
    if (sources.size <= MAX_REMEMBERED_MACHINES) break;
    sources.delete(oldest);
  }
  return source;
}

export const SERVER_MACHINE = "server";

export function useServerSnapshot(machineId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const container = useRef<HTMLDivElement>(null);
  const pollerRef = useRef<ReturnType<typeof createVisiblePoller<ServerSnapshot>> | null>(null);
  const forceRefresh = useRef(false);
  const [active, setActive] = useState(false);
  const [reading, setReading] = useState<{ machineId: string; snapshot: ServerSnapshot | null }>(() => ({
    machineId,
    snapshot: sourceFor(machineId).snapshot(),
  }));
  const snapshot = reading.machineId === machineId ? reading.snapshot : sourceFor(machineId).snapshot();
  const [error, setError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const source = sourceFor(machineId);
    setReading({ machineId, snapshot: source.snapshot() });
    setError(null);
    let intersecting = false;
    let pageHidden = false;
    const poller = createVisiblePoller({
      load: () => {
        const force = forceRefresh.current;
        forceRefresh.current = false;
        return source.load(
          () =>
            machineId === SERVER_MACHINE
              ? rpc.call(force ? "metrics_refresh" : "metrics_snapshot", null)
              : rpc.call("machine_snapshot", { hostId: machineId, force }),
          force,
        );
      },
      receive(next) { setReading({ machineId, snapshot: next }); setError(null); setReloading(false); },
      error(cause) { setError(cause instanceof Error ? cause.message : String(cause)); setReloading(false); },
      intervalMs: (next) => next.refreshIntervalMs,
    });
    pollerRef.current = poller;
    const update = () => {
      const visible = intersecting && !pageHidden && document.visibilityState === "visible" && element.getClientRects().length > 0;
      poller.setActive(visible);
      setActive(visible);
    };
    // Observe the persistent panel shell, not charts or a scrollable sentinel.
    // BB may retain a mounted panel while hiding it with display:none.
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
      update();
    });
    const hide = () => { pageHidden = true; update(); };
    const show = () => { pageHidden = false; update(); };
    observer.observe(element);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      poller.dispose();
      pollerRef.current = null;
    };
  }, [rpc, machineId]);

  const reload = useCallback(() => {
    forceRefresh.current = true;
    if (pollerRef.current?.refresh()) setReloading(true);
  }, []);

  return { container, active, snapshot, error, reload, reloading };
}
