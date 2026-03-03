/**
 * Result and summary builders for persisted run artifacts.
 *
 * These helpers normalize run record fields into API schema shapes while
 * ensuring mutable data is copied before publication.
 */
import { RUN_RESULT_SCHEMA_VERSION } from "./defaults.ts";
import {
  buildProgress,
  cloneRunFailure,
} from "./run-store-record-utils.ts";
import type {
  RunRecord,
  RunSummaryData,
  StoredRunResult,
} from "./run-store-types.ts";

export function buildRunSummary(run: RunRecord): RunSummaryData {
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
    summary: buildProgress(run),
  };
}

export function buildRunResult(run: RunRecord): StoredRunResult {
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
    summary: buildProgress(run),
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
