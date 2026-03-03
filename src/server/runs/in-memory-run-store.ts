/**
 * In-memory run state and event store for the server process.
 *
 * This store enforces run-capacity constraints, tracks per-case progress,
 * retains bounded event history, and expires terminal runs over time.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  RunResultDataSchema,
  RunStatusSchema,
  RunSummaryDataSchema,
} from "../api/schemas.ts";
import {
  DEFAULT_CASE_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  RUN_RESULT_SCHEMA_VERSION,
} from "./defaults.ts";
import {
  estimateTokenCount,
  estimateTokensPerSecond,
} from "./token-estimation.ts";

export const DEFAULT_MAX_TRACKED_RUNS = 1000;
export const DEFAULT_TERMINAL_RUN_RETENTION_MS = 6 * 60 * 60 * 1000;

const MAX_EVENTS_PER_RUN = 256;

type RunStatus = z.infer<typeof RunStatusSchema>;
type RunSummaryData = z.infer<typeof RunSummaryDataSchema>;
type StoredRunResult = z.infer<typeof RunResultDataSchema>["result"];

export type RunEventName =
  | "run.created"
  | "run.started"
  | "run.case.started"
  | "run.case.completed"
  | "run.case.failed"
  | "run.completed"
  | "run.failed"
  | "run.cancelled";

export interface RunEventRecord {
  event: RunEventName;
  payload: Record<string, unknown>;
}

export interface RunProgressSnapshot {
  totalCases: number;
  completedCases: number;
  failedCases: number;
}

export interface RunFailureDetails {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

type RunTargetType = "local" | "ssh";

interface StoredCaseOutcome {
  runId: string;
  caseId: string;
  promptId: string;
  index: number;
  status: "completed" | "failed";
  contextTokens: number;
  engineArgs: string[];
  requestParams: Record<string, unknown>;
  latencyMs: number;
  ttftMs: number | null;
  outputTokens: number;
  tokensPerSecond: number;
  promptEvalTokensPerSecond: number | null;
  acceptanceRatio: number | null;
  error: RunFailureDetails | null;
  outputText?: string;
  rawResponse?: unknown;
}

interface RunRecord {
  runId: string;
  engineId: string;
  engineVersion: string;
  orchestratorVersion: string;
  target: RunTargetType;
  targetProfileId: string | null;
  modelIdentifier: string;
  workloadId: string;
  engineArgs: string[];
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  totalCases: number;
  completedCases: number;
  failedCases: number;
  caseTimeoutMs: number;
  runTimeoutMs: number;
  caseOutcomes: StoredCaseOutcome[];
  failure: RunFailureDetails | null;
  metrics: Record<string, unknown> | null;
}

interface CreateQueuedRunInput {
  engineId: string;
  engineVersion?: string;
  orchestratorVersion?: string;
  target?: RunTargetType;
  targetProfileId?: string;
  modelIdentifier: string;
  workloadId: string;
  engineArgs?: string[];
  totalCases?: number;
  caseTimeoutMs?: number;
  runTimeoutMs?: number;
}

type RunEventListener = (event: RunEventRecord) => void;

export type CreateQueuedRunResult =
  | {
      ok: true;
      runId: string;
    }
  | {
      ok: false;
      reason: "capacity" | "concurrency";
    };

interface InMemoryRunStoreOptions {
  maxTrackedRuns?: number;
  terminalRunRetentionMs?: number;
}

export class InMemoryRunStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly runResults = new Map<string, StoredRunResult>();
  private readonly runEvents = new Map<string, RunEventRecord[]>();
  private readonly runEventListeners = new Map<string, Set<RunEventListener>>();
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
      ...this.buildProgress(record),
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

    return this.isRunStatusCancellable(status);
  }

  getRunSummary(runId: string): RunSummaryData | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }

    return this.buildRunSummary(run);
  }

  getRunProgress(runId: string): RunProgressSnapshot | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }

    return this.buildProgress(run);
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

    this.transitionRunStatus(run, "running", atIsoTimestamp);
    this.emitRunEvent(runId, "run.started", {
      status: run.status,
      ...this.buildProgress(run),
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

    const progress = this.buildProgress(run);
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

    const latencyMs = normalizeNonNegativeInteger(input.latencyMs, 0);
    const outputTokens = estimateTokenCount(input.outputText);

    run.caseOutcomes.push({
      runId,
      caseId: input.caseId,
      promptId: input.promptId,
      index: input.index,
      status: "completed",
      contextTokens: normalizeNonNegativeInteger(input.contextTokens, 0),
      engineArgs: [...run.engineArgs],
      requestParams: {
        ...input.requestParams,
      },
      latencyMs,
      ttftMs: null,
      outputTokens,
      tokensPerSecond: estimateTokensPerSecond(outputTokens, latencyMs),
      promptEvalTokensPerSecond: null,
      acceptanceRatio: null,
      error: null,
      outputText: input.outputText,
      ...(input.rawResponse === undefined
        ? {}
        : {
            rawResponse: input.rawResponse,
          }),
    });
    run.completedCases += 1;
    this.reconcileTotalCases(run);

    const progress = this.buildProgress(run);
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

    const sanitizedError = cloneRunFailure(input.error);

    run.caseOutcomes.push({
      runId,
      caseId: input.caseId,
      promptId: input.promptId,
      index: input.index,
      status: "failed",
      contextTokens: normalizeNonNegativeInteger(input.contextTokens, 0),
      engineArgs: [...run.engineArgs],
      requestParams: {
        ...input.requestParams,
      },
      latencyMs: normalizeNonNegativeInteger(input.latencyMs, 0),
      ttftMs: null,
      outputTokens: 0,
      tokensPerSecond: 0,
      promptEvalTokensPerSecond: null,
      acceptanceRatio: null,
      error: sanitizedError,
    });
    run.failedCases += 1;
    this.reconcileTotalCases(run);

    const progress = this.buildProgress(run);
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

    if (this.isRunStatusTerminal(run.status)) {
      return run.status;
    }

    run.metrics = {
      ...metrics,
    };
    this.transitionRunStatus(run, "completed", atIsoTimestamp);
    this.runResults.set(run.runId, this.buildRunResult(run));
    this.emitRunEvent(runId, "run.completed", {
      status: run.status,
      ...this.buildProgress(run),
    });

    return run.status;
  }

  failRun(runId: string, atIsoTimestamp: string, failure: RunFailureDetails): RunStatus | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }

    if (this.isRunStatusTerminal(run.status)) {
      return run.status;
    }

    run.failure = cloneRunFailure(failure);
    this.transitionRunStatus(run, "failed", atIsoTimestamp);
    this.runResults.set(run.runId, this.buildRunResult(run));
    this.emitRunEvent(runId, "run.failed", {
      status: run.status,
      error: run.failure,
      ...this.buildProgress(run),
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

    if (this.isRunStatusCancellable(run.status)) {
      this.transitionRunStatus(run, "cancelled", atIsoTimestamp);
      this.runResults.set(run.runId, this.buildRunResult(run));
      this.emitRunEvent(runId, "run.cancelled", {
        status: run.status,
        ...(reason
          ? {
              reason,
            }
          : {}),
        ...this.buildProgress(run),
      });
    }

    return run.status;
  }

  listRunEvents(runId: string): RunEventRecord[] {
    return [...(this.runEvents.get(runId) ?? [])];
  }

  subscribeRunEvents(runId: string, listener: RunEventListener): () => void {
    if (!this.runs.has(runId)) {
      return () => {
        return;
      };
    }

    const listeners = this.runEventListeners.get(runId) ?? new Set<RunEventListener>();
    listeners.add(listener);
    this.runEventListeners.set(runId, listeners);

    return () => {
      const activeListeners = this.runEventListeners.get(runId);
      if (!activeListeners) {
        return;
      }

      activeListeners.delete(listener);
      if (activeListeners.size === 0) {
        this.runEventListeners.delete(runId);
      }
    };
  }

  private emitRunEvent(
    runId: string,
    event: RunEventName,
    payload: Record<string, unknown>,
  ): void {
    if (!this.runs.has(runId)) {
      return;
    }

    const record: RunEventRecord = {
      event,
      payload: {
        runId,
        ...payload,
      },
    };

    const events = this.runEvents.get(runId) ?? [];
    events.push(record);
    if (events.length > MAX_EVENTS_PER_RUN) {
      events.splice(0, events.length - MAX_EVENTS_PER_RUN);
    }
    this.runEvents.set(runId, events);

    const listeners = this.runEventListeners.get(runId);
    if (!listeners || listeners.size === 0) {
      return;
    }

    for (const listener of listeners) {
      try {
        listener(record);
      } catch {
        // Listener failures should not interrupt run state transitions.
      }
    }
  }

  private buildRunSummary(run: RunRecord): RunSummaryData {
    return {
      runId: run.runId,
      status: run.status,
      engineId: run.engineId,
      workloadId: run.workloadId,
      model: {
        identifier: run.modelIdentifier,
      },
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      summary: this.buildProgress(run),
    };
  }

  private buildRunResult(run: RunRecord): StoredRunResult {
    const startedAtMs = Date.parse(run.startedAt ?? run.createdAt);
    const finishedAtMs = Date.parse(run.finishedAt ?? run.createdAt);

    const durationMs =
      Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)
        ? Math.max(0, finishedAtMs - startedAtMs)
        : 0;

    return {
      schemaVersion: RUN_RESULT_SCHEMA_VERSION,
      runId: run.runId,
      createdAt: run.createdAt,
      orchestratorVersion: run.orchestratorVersion,
      workloadId: run.workloadId,
      engineId: run.engineId,
      engineVersion: run.engineVersion,
      target: run.target,
      ...(run.target === "ssh" && run.targetProfileId
        ? {
            targetProfileId: run.targetProfileId,
          }
        : {}),
      model: {
        identifier: run.modelIdentifier,
      },
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs,
      timeouts: {
        caseMs: run.caseTimeoutMs,
        runMs: run.runTimeoutMs,
      },
      summary: this.buildProgress(run),
      cases: run.caseOutcomes.map((caseOutcome) => ({
        runId: caseOutcome.runId,
        caseId: caseOutcome.caseId,
        promptId: caseOutcome.promptId,
        index: caseOutcome.index,
        contextTokens: caseOutcome.contextTokens,
        engineArgs: [...caseOutcome.engineArgs],
        requestParams: {
          ...caseOutcome.requestParams,
        },
        status: caseOutcome.status,
        latencyMs: caseOutcome.latencyMs,
        ttftMs: caseOutcome.ttftMs,
        outputTokens: caseOutcome.outputTokens,
        tokensPerSecond: caseOutcome.tokensPerSecond,
        promptEvalTokensPerSecond: caseOutcome.promptEvalTokensPerSecond,
        acceptanceRatio: caseOutcome.acceptanceRatio,
        error: caseOutcome.error ? cloneRunFailure(caseOutcome.error) : null,
        ...(caseOutcome.outputText === undefined
          ? {}
          : {
              outputText: caseOutcome.outputText,
            }),
        ...(caseOutcome.rawResponse === undefined
          ? {}
          : {
              rawResponse: caseOutcome.rawResponse,
            }),
      })),
      error: run.failure ? cloneRunFailure(run.failure) : null,
      ...(run.metrics
        ? {
            metricsExtra: {
              ...run.metrics,
            },
          }
        : {}),
    };
  }

  private buildProgress(run: RunRecord): RunProgressSnapshot {
    return {
      totalCases: run.totalCases,
      completedCases: run.completedCases,
      failedCases: run.failedCases,
    };
  }

  private reconcileTotalCases(run: RunRecord): void {
    const observedCases = run.completedCases + run.failedCases;
    if (observedCases > run.totalCases) {
      run.totalCases = observedCases;
    }
  }

  private pruneExpiredTerminalRuns(now: number): void {
    for (const [runId, run] of this.runs) {
      if (!this.isRunStatusTerminal(run.status) || !run.finishedAt) {
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
      if (this.isRunStatusTerminal(run.status)) {
        return runId;
      }
    }

    return null;
  }

  private deleteRun(runId: string): void {
    this.runs.delete(runId);
    this.runResults.delete(runId);
    this.runEvents.delete(runId);
    this.runEventListeners.delete(runId);
  }

  private isRunStatusTerminal(status: RunStatus): boolean {
    return status === "completed" || status === "failed" || status === "cancelled";
  }

  private isRunStatusCancellable(status: RunStatus): boolean {
    return status === "queued" || status === "running";
  }

  private transitionRunStatus(
    run: RunRecord,
    status: RunStatus,
    atIsoTimestamp: string,
  ): void {
    if (run.status === status) {
      return;
    }

    if (this.isRunStatusTerminal(run.status)) {
      return;
    }

    run.status = status;

    if (status === "running" && !run.startedAt) {
      run.startedAt = atIsoTimestamp;
    }

    if (this.isRunStatusTerminal(status)) {
      run.finishedAt = atIsoTimestamp;
    }
  }
}

function cloneRunFailure(failure: RunFailureDetails): RunFailureDetails {
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

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(value);
  } catch {
    return {
      ...value,
    };
  }
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.trunc(value));
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return value > 0 ? Math.trunc(value) : fallback;
}
