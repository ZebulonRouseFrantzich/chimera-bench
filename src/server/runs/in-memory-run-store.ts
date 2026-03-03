/**
 * In-memory run state and event store for the server process.
 *
 * This store enforces run-capacity constraints, tracks per-case progress,
 * retains bounded event history, and expires terminal runs over time.
 */
import { randomUUID } from "node:crypto";
import {
  DEFAULT_CASE_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
} from "./defaults.ts";
import {
  recordCompletedCaseOutcome,
  recordFailedCaseOutcome,
} from "./run-store-case-outcomes.ts";
import { RunStoreEvents } from "./run-store-events.ts";
import {
  buildProgress,
  cloneRunFailure,
  isRunStatusCancellable,
  isRunStatusTerminal,
  normalizeNonNegativeInteger,
  normalizePositiveInteger,
  transitionRunStatus,
} from "./run-store-record-utils.ts";
import {
  buildRunResult,
  buildRunSummary,
} from "./run-store-results.ts";
import {
  DEFAULT_MAX_TRACKED_RUNS,
  DEFAULT_TERMINAL_RUN_RETENTION_MS,
  type CreateQueuedRunInput,
  type CreateQueuedRunResult,
  type InMemoryRunStoreOptions,
  type RunEventListener,
  type RunEventName,
  type RunEventRecord,
  type RunFailureDetails,
  type RunProgressSnapshot,
  type RunRecord,
  type RunStatus,
  type RunSummaryData,
  type StoredRunResult,
} from "./run-store-types.ts";

export {
  DEFAULT_MAX_TRACKED_RUNS,
  DEFAULT_TERMINAL_RUN_RETENTION_MS,
};
export type {
  CreateQueuedRunResult,
  RunEventName,
  RunEventRecord,
  RunFailureDetails,
  RunProgressSnapshot,
};

export class InMemoryRunStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly runResults = new Map<string, StoredRunResult>();
  private readonly events = new RunStoreEvents();
  private readonly maxTrackedRuns: number;
  private readonly terminalRunRetentionMs: number;

  constructor(options: InMemoryRunStoreOptions = {}) {
    this.maxTrackedRuns = options.maxTrackedRuns ?? DEFAULT_MAX_TRACKED_RUNS;
    this.terminalRunRetentionMs =
      options.terminalRunRetentionMs ?? DEFAULT_TERMINAL_RUN_RETENTION_MS;
  }

  getMaxTrackedRuns(): number {
    return this.maxTrackedRuns;
  }

  hasActiveRun(): boolean {
    for (const run of this.runs.values()) {
      if (run.status === "queued" || run.status === "running") {
        return true;
      }
    }

    return false;
  }

  ensureCapacity(now = Date.now()): boolean {
    this.pruneExpiredTerminalRuns(now);

    while (this.runs.size >= this.maxTrackedRuns) {
      const runIdToEvict = this.findOldestTerminalRunId();
      if (!runIdToEvict) {
        return false;
      }

      this.deleteRun(runIdToEvict);
    }

    return true;
  }

  tryCreateQueuedRun(input: CreateQueuedRunInput, now = Date.now()): string | null {
    const result = this.tryCreateQueuedRunDetailed(input, now);
    return result.ok ? result.runId : null;
  }

  tryCreateQueuedRunDetailed(
    input: CreateQueuedRunInput,
    now = Date.now(),
  ): CreateQueuedRunResult {
    // This method is synchronous; no async gaps exist between the active-run
    // check and insertion in the current single-process server architecture.
    if (this.hasActiveRun()) {
      return {
        ok: false,
        reason: "concurrency",
      };
    }

    if (!this.ensureCapacity(now)) {
      return {
        ok: false,
        reason: "capacity",
      };
    }

    const runId = `run_${randomUUID()}`;
    const createdAt = new Date(now).toISOString();
    const totalCases = normalizeNonNegativeInteger(input.totalCases, 0);

    const record: RunRecord = {
      runId,
      engineId: input.engineId,
      engineVersion: input.engineVersion ?? "unknown",
      orchestratorVersion: input.orchestratorVersion ?? "0.0.0",
      // Kept for backwards compatibility with direct store callers that predate
      // explicit target wiring in run route handling.
      target: input.target ?? "local",
      targetProfileId:
        input.target === "ssh" && input.targetProfileId ? input.targetProfileId : null,
      modelIdentifier: input.modelIdentifier,
      workloadId: input.workloadId,
      engineArgs: [...(input.engineArgs ?? [])],
      status: "queued",
      createdAt,
      startedAt: null,
      finishedAt: null,
      totalCases,
      completedCases: 0,
      failedCases: 0,
      caseTimeoutMs: normalizePositiveInteger(input.caseTimeoutMs, DEFAULT_CASE_TIMEOUT_MS),
      runTimeoutMs: normalizePositiveInteger(input.runTimeoutMs, DEFAULT_RUN_TIMEOUT_MS),
      caseOutcomes: [],
      failure: null,
      metrics: null,
    };

    this.runs.set(runId, record);
    this.emitRunEvent(runId, "run.created", {
      status: record.status,
      workloadId: record.workloadId,
      ...buildProgress(record),
    });

    return {
      ok: true,
      runId,
    };
  }

  hasRun(runId: string): boolean {
    return this.runs.has(runId);
  }

  getRunStatus(runId: string): RunStatus | undefined {
    return this.runs.get(runId)?.status;
  }

  isRunCancellable(runId: string): boolean {
    const status = this.getRunStatus(runId);
    if (!status) {
      return false;
    }

    return isRunStatusCancellable(status);
  }

  getRunSummary(runId: string): RunSummaryData | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }

    return buildRunSummary(run);
  }

  getRunProgress(runId: string): RunProgressSnapshot | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }

    return buildProgress(run);
  }

  getRunResult(runId: string): StoredRunResult | undefined {
    return this.runResults.get(runId);
  }

  markRunRunning(runId: string, atIsoTimestamp: string): RunStatus | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }

    if (run.status !== "queued") {
      return run.status;
    }

    transitionRunStatus(run, "running", atIsoTimestamp);
    this.emitRunEvent(runId, "run.started", {
      status: run.status,
      ...buildProgress(run),
    });

    return run.status;
  }

  recordCaseStarted(
    runId: string,
    input: {
      caseId: string;
      promptId: string;
      index: number;
    },
  ): RunProgressSnapshot | undefined {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") {
      return undefined;
    }

    const progress = buildProgress(run);
    this.emitRunEvent(runId, "run.case.started", {
      caseId: input.caseId,
      promptId: input.promptId,
      index: input.index,
      ...progress,
    });

    return progress;
  }

  recordCaseCompleted(
    runId: string,
    input: {
      caseId: string;
      promptId: string;
      index: number;
      contextTokens: number;
      latencyMs: number;
      outputText: string;
      requestParams: Record<string, unknown>;
      rawResponse?: unknown;
    },
  ): RunProgressSnapshot | undefined {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") {
      return undefined;
    }

    recordCompletedCaseOutcome(runId, run, input);

    const progress = buildProgress(run);
    this.emitRunEvent(runId, "run.case.completed", {
      caseId: input.caseId,
      promptId: input.promptId,
      index: input.index,
      ...progress,
    });

    return progress;
  }

  recordCaseFailed(
    runId: string,
    input: {
      caseId: string;
      promptId: string;
      index: number;
      contextTokens: number;
      latencyMs: number;
      requestParams: Record<string, unknown>;
      error: RunFailureDetails;
    },
  ): RunProgressSnapshot | undefined {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") {
      return undefined;
    }

    const sanitizedError = recordFailedCaseOutcome(runId, run, input);

    const progress = buildProgress(run);
    this.emitRunEvent(runId, "run.case.failed", {
      caseId: input.caseId,
      promptId: input.promptId,
      index: input.index,
      error: sanitizedError,
      ...progress,
    });

    return progress;
  }

  completeRun(
    runId: string,
    atIsoTimestamp: string,
    metrics: Record<string, unknown> = {},
  ): RunStatus | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }

    if (isRunStatusTerminal(run.status)) {
      return run.status;
    }

    run.metrics = {
      ...metrics,
    };
    transitionRunStatus(run, "completed", atIsoTimestamp);
    this.runResults.set(run.runId, buildRunResult(run));
    this.emitRunEvent(runId, "run.completed", {
      status: run.status,
      ...buildProgress(run),
    });

    return run.status;
  }

  failRun(
    runId: string,
    atIsoTimestamp: string,
    failure: RunFailureDetails,
  ): RunStatus | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }

    if (isRunStatusTerminal(run.status)) {
      return run.status;
    }

    run.failure = cloneRunFailure(failure);
    transitionRunStatus(run, "failed", atIsoTimestamp);
    this.runResults.set(run.runId, buildRunResult(run));
    this.emitRunEvent(runId, "run.failed", {
      status: run.status,
      error: run.failure,
      ...buildProgress(run),
    });

    return run.status;
  }

  cancelRun(
    runId: string,
    atIsoTimestamp: string,
    reason?: string,
  ): RunStatus | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }

    if (isRunStatusCancellable(run.status)) {
      transitionRunStatus(run, "cancelled", atIsoTimestamp);
      this.runResults.set(run.runId, buildRunResult(run));
      this.emitRunEvent(runId, "run.cancelled", {
        status: run.status,
        ...(reason
          ? {
              reason,
            }
          : {}),
        ...buildProgress(run),
      });
    }

    return run.status;
  }

  listRunEvents(runId: string): RunEventRecord[] {
    return this.events.listRunEvents(runId);
  }

  subscribeRunEvents(runId: string, listener: RunEventListener): () => void {
    return this.events.subscribeRunEvents(runId, listener, (candidateRunId) => {
      return this.runs.has(candidateRunId);
    });
  }

  private emitRunEvent(
    runId: string,
    event: RunEventName,
    payload: Record<string, unknown>,
  ): void {
    this.events.emitRunEvent(runId, event, payload, (candidateRunId) => {
      return this.runs.has(candidateRunId);
    });
  }

  private pruneExpiredTerminalRuns(now: number): void {
    for (const [runId, run] of this.runs) {
      if (!isRunStatusTerminal(run.status) || !run.finishedAt) {
        continue;
      }

      const finishedAtMs = Date.parse(run.finishedAt);
      if (!Number.isFinite(finishedAtMs)) {
        continue;
      }

      if (now - finishedAtMs < this.terminalRunRetentionMs) {
        continue;
      }

      this.deleteRun(runId);
    }
  }

  private findOldestTerminalRunId(): string | null {
    for (const [runId, run] of this.runs) {
      if (isRunStatusTerminal(run.status)) {
        return runId;
      }
    }

    return null;
  }

  private deleteRun(runId: string): void {
    this.runs.delete(runId);
    this.runResults.delete(runId);
    this.events.deleteRun(runId);
  }
}
