import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Machine } from "../server";
import { SERVER_MACHINE } from "../hooks/use-server-snapshot";
import { machineKey } from "../hooks/use-machines";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const MACHINE_GROUPS: { label: string; includes: (machine: Machine) => boolean }[] = [
  { label: "Machines", includes: (machine) => !machine.isBox },
  { label: "Boxes", includes: (machine) => machine.isBox },
];

function matchesQuery(machine: Machine, query: string): boolean {
  return machine.name.toLowerCase().includes(query.trim().toLowerCase());
}

function displayName(machines: Machine[] | null, selected: string): string {
  const machine = machines?.find((candidate) => machineKey(candidate) === selected);
  if (machine) return machine.name;
  return selected === SERVER_MACHINE ? "This bb server" : "Machine";
}

export function MachinePicker({
  machines,
  selected,
  onSelect,
  onOpen,
}: {
  machines: Machine[] | null;
  selected: string;
  onSelect: (machineId: string) => void;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(
    () =>
      MACHINE_GROUPS.map(({ label, includes }) => ({
        label,
        machines: (machines ?? []).filter(
          (machine) => includes(machine) && matchesQuery(machine, query),
        ),
      })).filter((group) => group.machines.length > 0),
    [machines, query],
  );
  const flat = groups.flatMap((group) => group.machines);

  const choose = (machine: Machine) => {
    onSelect(machineKey(machine));
    setOpen(false);
  };

  const moveHighlight = (next: number) => {
    const bounded = Math.max(0, Math.min(flat.length - 1, next));
    setHighlighted(bounded);
    listRef.current
      ?.querySelector(`[data-machine-index="${bounded}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(highlighted + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(highlighted - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const machine = flat[highlighted];
      if (machine) choose(machine);
    }
  };

  let index = -1;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          onOpen();
          setQuery("");
          setHighlighted(Math.max(0, (machines ?? []).findIndex((machine) => machineKey(machine) === selected)));
        }
      }}
    >
      <PopoverTrigger
        aria-label="Machine"
        className="flex h-6 min-w-0 max-w-full shrink items-center gap-1 rounded-md px-1.5 text-xs font-medium text-sidebar-foreground hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:opacity-50 data-[state=open]:bg-sidebar-accent"
      >
        <span className="min-w-0 truncate">{displayName(machines, selected)}</span>
        <Icon name="ChevronDown" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </PopoverTrigger>
      <PopoverContent className="w-60 p-0" side="top">
        <div className="border-b border-border p-1">
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlighted(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search machines"
            aria-label="Search machines"
            aria-controls="beacon-machine-list"
            className="h-7 w-full rounded-sm bg-transparent px-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none"
          />
        </div>
        <div
          id="beacon-machine-list"
          ref={listRef}
          role="listbox"
          aria-label="Machines"
          className="max-h-56 overflow-y-auto p-1"
        >
          {machines === null ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading machines</p>
          ) : flat.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No machines match.</p>
          ) : (
            groups.map((group) => (
              <div key={group.label} role="group" aria-label={group.label}>
                <p className="px-2 pb-1 pt-1.5 text-2xs font-medium text-muted-foreground">{group.label}</p>
                {group.machines.map((machine) => {
                  index += 1;
                  const itemIndex = index;
                  const isSelected = machineKey(machine) === selected;
                  return (
                    <button
                      key={machine.id}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-machine-index={itemIndex}
                      onMouseMove={() => setHighlighted(itemIndex)}
                      onClick={() => choose(machine)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-foreground outline-none",
                        itemIndex === highlighted && "bg-state-hover",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{machine.name}</span>
                      {machine.isServer ? <span className="shrink-0 text-2xs text-muted-foreground">server</span> : null}
                      {isSelected ? <Icon name="Check" className="size-3.5 shrink-0" aria-hidden /> : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
