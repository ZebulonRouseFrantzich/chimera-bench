import type {
  RunFailureDetails,
  RunProgressSnapshot,
  RunRecord,
  RunStatus,
} from "./run-store-types.ts";

export function cloneRunFailure(failure: RunFailureDetails): RunFailureDetails {
  return {
    code: failure.code,
    message: failure.message,
    ...(failure.details
      ? {
          details: cloneRecord(failure.details),
        }
      : {}),
  };
}

export function normalizeNonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.trunc(value));
}

export function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return value > 0 ? Math.trunc(value) : fallback;
}

export function buildProgress(run: RunRecord): RunProgressSnapshot {
  return {
    totalCases: run.totalCases,
    completedCases: run.completedCases,
    failedCases: run.failedCases,
  };
}

export function reconcileTotalCases(run: RunRecord): void {
  const observedCases = run.completedCases + run.failedCases;
  if (observedCases > run.totalCases) {
    run.totalCases = observedCases;
  }
}

export function isRunStatusTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function isRunStatusCancellable(status: RunStatus): boolean {
  return status === "queued" || status === "running";
}

export function transitionRunStatus(
  run: RunRecord,
  status: RunStatus,
  atIsoTimestamp: string,
): void {
  if (run.status === status || isRunStatusTerminal(run.status)) {
    return;
  }

  run.status = status;

  if (status === "running" && !run.startedAt) {
    run.startedAt = atIsoTimestamp;
  }

  if (isRunStatusTerminal(status)) {
    run.finishedAt = atIsoTimestamp;
  }
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(value);
  } catch {
    return {
      ...value,
    };
  }
}
