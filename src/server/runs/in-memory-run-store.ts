import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  RunResultDataSchema,
  RunStatusSchema,
  RunSummaryDataSchema,
} from "../api/schemas.ts";

export const DEFAULT_MAX_TRACKED_RUNS = 1000;
export const DEFAULT_TERMINAL_RUN_RETENTION_MS = 6 * 60 * 60 * 1000;

type RunStatus = z.infer<typeof RunStatusSchema>;
type RunSummaryData = z.infer<typeof RunSummaryDataSchema>;
type StoredRunResult = z.infer<typeof RunResultDataSchema>["result"];

interface RunRecord {
  runId: string;
  engineId: string;
  modelIdentifier: string;
  workloadId: string;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface CreateQueuedRunInput {
  engineId: string;
  modelIdentifier: string;
  workloadId: string;
}

interface InMemoryRunStoreOptions {
  maxTrackedRuns?: number;
  terminalRunRetentionMs?: number;
}

export class InMemoryRunStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly runResults = new Map<string, StoredRunResult>();
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

  ensureCapacity(now = Date.now()): boolean {
    this.pruneExpiredTerminalRuns(now);

    while (this.runs.size >= this.maxTrackedRuns) {
      const runIdToEvict = this.findOldestTerminalRunId();
      if (!runIdToEvict) {
        return false;
      }

      this.runs.delete(runIdToEvict);
      this.runResults.delete(runIdToEvict);
    }

    return true;
  }

  tryCreateQueuedRun(input: CreateQueuedRunInput, now = Date.now()): string | null {
    if (!this.ensureCapacity(now)) {
      return null;
    }

    const runId = `run_${randomUUID()}`;
    const createdAt = new Date().toISOString();

    this.runs.set(runId, {
      runId,
      engineId: input.engineId,
      modelIdentifier: input.modelIdentifier,
      workloadId: input.workloadId,
      status: "queued",
      createdAt,
      startedAt: null,
      finishedAt: null,
    });

    return runId;
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

  getRunResult(runId: string): StoredRunResult | undefined {
    return this.runResults.get(runId);
  }

  cancelRun(runId: string, atIsoTimestamp: string): RunStatus | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }

    if (this.isRunStatusCancellable(run.status)) {
      this.transitionRunStatus(run, "cancelled", atIsoTimestamp);

      if (!this.runResults.has(run.runId)) {
        this.runResults.set(run.runId, this.buildStubResult(run, "cancelled"));
      }
    }

    return run.status;
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
      summary: {
        totalCases: 0,
        completedCases: 0,
        failedCases: 0,
      },
    };
  }

  private buildStubResult(run: RunRecord, status: RunStatus): StoredRunResult {
    return {
      schemaVersion: "0.1.0-preview",
      runId: run.runId,
      status,
      workloadId: run.workloadId,
      cases: [],
    };
  }

  private pruneExpiredTerminalRuns(now: number): void {
    // Safe to delete while iterating a Map; iteration semantics handle this.
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

      this.runs.delete(runId);
      this.runResults.delete(runId);
    }
  }

  private findOldestTerminalRunId(): string | null {
    // Intentional approximation: Map iteration order tracks insertion order.
    for (const [runId, run] of this.runs) {
      if (this.isRunStatusTerminal(run.status)) {
        return runId;
      }
    }

    return null;
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

    if (this.isRunStatusTerminal(status)) {
      run.finishedAt = atIsoTimestamp;
    }
  }
}
