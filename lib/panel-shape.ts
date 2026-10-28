import type { ServerSnapshot } from "../server";

export interface PanelShape {
  gpu: boolean;
  battery: boolean;
}

const NO_OPTIONAL_SECTIONS: PanelShape = { gpu: false, battery: false };

function storageKey(machineId: string): string {
  return `beacon:shape:${machineId}`;
}

export function hasGpuReadings(snapshot: ServerSnapshot): boolean {
  const sensors = snapshot.sensors;
  return Boolean(sensors && (sensors.gpuPercent !== null || sensors.gpuTempC !== null));
}

export function readPanelShape(machineId: string): PanelShape {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey(machineId)) ?? "null");
    if (typeof stored !== "object" || stored === null) return NO_OPTIONAL_SECTIONS;
    const shape = stored as Record<string, unknown>;
    return { gpu: shape.gpu === true, battery: shape.battery === true };
  } catch {
    return NO_OPTIONAL_SECTIONS;
  }
}

export function rememberPanelShape(machineId: string, shape: PanelShape): void {
  try {
    localStorage.setItem(storageKey(machineId), JSON.stringify(shape));
  } catch {
    return;
  }
}
