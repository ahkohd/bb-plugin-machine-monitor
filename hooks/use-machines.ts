import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { Machine, rpcContract } from "../server";
import { SERVER_MACHINE } from "./use-server-snapshot";

const SELECTED_MACHINE_KEY = "beacon:machine";

function readSelectedMachine(): string {
  try {
    return globalThis.localStorage?.getItem(SELECTED_MACHINE_KEY) ?? SERVER_MACHINE;
  } catch {
    return SERVER_MACHINE;
  }
}

function writeSelectedMachine(machineId: string): void {
  try {
    globalThis.localStorage?.setItem(SELECTED_MACHINE_KEY, machineId);
  } catch {
    return;
  }
}

export function machineKey(machine: Machine): string {
  return machine.isServer ? SERVER_MACHINE : machine.id;
}

export function useMachines() {
  const rpc = useRpc<typeof rpcContract>();
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [selected, setSelectedState] = useState(readSelectedMachine);

  useEffect(() => {
    let cancelled = false;
    void rpc.call("machines_list", null).then(
      ({ machines: next }) => { if (!cancelled) setMachines(next); },
      () => { if (!cancelled) setMachines([]); },
    );
    return () => { cancelled = true; };
  }, [rpc]);

  const selectedExists =
    selected === SERVER_MACHINE ||
    machines === null ||
    machines.some((machine) => machineKey(machine) === selected);

  const setSelected = useCallback((machineId: string) => {
    setSelectedState(machineId);
    writeSelectedMachine(machineId);
  }, []);

  return {
    machines,
    selected: selectedExists ? selected : SERVER_MACHINE,
    setSelected,
  };
}
