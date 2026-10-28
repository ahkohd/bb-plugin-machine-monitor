import { useState } from "react";
import {
  experimental_copyToClipboard as copyToClipboard,
  experimental_Icon as Icon,
} from "@get-bb/plugin-sdk/app";
import type { TailscaleInfo } from "../lib/tailscale.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const COPIED_MS = 1500;

function CopyValue({ label, value, title }: { label: string; value: string; title?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    const copied = await copyToClipboard({ text: value });
    setState(copied ? "copied" : "failed");
    setTimeout(() => setState("idle"), COPIED_MS);
  };
  const tooltip = state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : (title ?? `Copy ${label.toLowerCase()}`);
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <Tooltip delayDuration={350} disableHoverableContent open={state === "idle" ? undefined : true}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={`Copy ${label.toLowerCase()} ${value}`}
            className="group/copy -mr-1 flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          >
            <Icon
              name={state === "copied" ? "Check" : "Copy"}
              className={cn(
                "size-3 shrink-0 transition-opacity group-hover/copy:opacity-100 group-focus-visible/copy:opacity-100",
                state === "idle" ? "opacity-0" : "opacity-100",
              )}
              aria-hidden
            />
            <span className="min-w-0 truncate tabular-nums">{value}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{tooltip}</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function TailscaleRows({ tailscale }: { tailscale: TailscaleInfo }) {
  return (
    <>
      <CopyValue label="Name" value={tailscale.dnsName} />
      {tailscale.ipv4 ? (
        <CopyValue
          label="IPv4"
          value={tailscale.ipv4}
          title={tailscale.ipv6 ? `Copy IPv4 · IPv6 ${tailscale.ipv6}` : undefined}
        />
      ) : null}
      {tailscale.ipv6 && !tailscale.ipv4 ? <CopyValue label="IPv6" value={tailscale.ipv6} /> : null}
      {tailscale.tags.length > 0 ? (
        <CopyValue label={tailscale.tags.length === 1 ? "Tag" : "Tags"} value={tailscale.tags.join(", ")} />
      ) : null}
    </>
  );
}
