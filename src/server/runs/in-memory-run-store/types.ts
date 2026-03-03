import { z } from "zod";
import {
  RunResultDataSchema,
  RunStatusSchema,
  RunSummaryDataSchema,
} from "../../api/schemas.ts";

export const DEFAULT_MAX_TRACKED_RUNS = 1000;
export const DEFAULT_TERMINAL_RUN_RETENTION_MS = 6 * 60 * 60 * 1000;

export const MAX_EVENTS_PER_RUN = 256;

export type RunStatus = z.infer<typeof RunStatusSchema>;
export type RunSummaryData = z.infer<typeof RunSummaryDataSchema>;
export type StoredRunResult = z.infer<typeof RunResultDataSchema>["result"];

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

export type RunTargetType = "local" | "ssh";

export interface StoredCaseOutcome {
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

export interface RunRecord {
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

export interface CreateQueuedRunInput {
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

export type RunEventListener = (event: RunEventRecord) => void;

export type CreateQueuedRunResult =
  | {
      ok: true;
      runId: string;
    }
  | {
      ok: false;
      reason: "capacity" | "concurrency";
    };

export interface InMemoryRunStoreOptions {
  maxTrackedRuns?: number;
  terminalRunRetentionMs?: number;
}
