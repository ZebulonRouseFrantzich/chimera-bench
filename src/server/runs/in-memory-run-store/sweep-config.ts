import {
  normalizeNonNegativeInteger,
  normalizePositiveInteger,
} from "./record-utils.ts";
import type {
  StoredSweepAxes,
  StoredSweepConfig,
} from "./types.ts";

const SWEEP_CLONE_ERROR_MESSAGE =
  "Failed to clone sweep axis value. Expected JSON-compatible input.";

export function cloneStoredSweepConfig(sweep: StoredSweepConfig): StoredSweepConfig {
  return {
    axes: cloneSweepAxes(sweep.axes),
    repetitions: normalizePositiveInteger(sweep.repetitions, 1),
    maxCases: normalizePositiveInteger(sweep.maxCases, 1),
    plannedCases: normalizeNonNegativeInteger(sweep.plannedCases, 0),
  };
}

export function cloneSweepAxes(axes: StoredSweepAxes): StoredSweepAxes {
  return {
    serverArgs: Object.fromEntries(
      Object.entries(axes.serverArgs).map(([axisKey, fragments]) => {
        return [
          axisKey,
          fragments.map((fragment) => {
            return [...fragment];
          }),
        ];
      }),
    ),
    requestParams: Object.fromEntries(
      Object.entries(axes.requestParams).map(([axisKey, values]) => {
        return [
          axisKey,
          values.map((value) => {
            return cloneSweepValue(value);
          }),
        ];
      }),
    ),
  };
}

function cloneSweepValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    throw new Error(SWEEP_CLONE_ERROR_MESSAGE);
  }
}
