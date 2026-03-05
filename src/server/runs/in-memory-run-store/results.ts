/**
 * Result and summary builders for persisted run artifacts.
 *
 * These helpers normalize run record fields into API schema shapes while
 * ensuring mutable data is copied before publication.
 */
import { RUN_RESULT_SCHEMA_VERSION } from "../defaults.ts";
import {
  buildProgress,
  cloneRunFailure,
} from "./record-utils.ts";
import { cloneSweepAxes } from "./sweep-config.ts";
import type {
  RunRecord,
  RunSummaryData,
  StoredCaseOutcome,
  StoredRunResult,
  StoredSweepResult,
  StoredSweepConfig,
  SweepRankingEntry,
} from "./types.ts";

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
    ...(run.sweep
      ? {
          sweep: buildSweepResult(run.sweep, run.caseOutcomes),
        }
      : {}),
    ...(run.metrics
      ? {
          metricsExtra: {
            ...run.metrics,
          },
        }
      : {}),
  };
}

function buildSweepResult(
  sweep: StoredSweepConfig,
  caseOutcomes: readonly StoredCaseOutcome[],
): StoredSweepResult {
  const ranking = buildSweepRanking(caseOutcomes);

  return {
    axes: cloneSweepAxes(sweep.axes),
    repetitions: sweep.repetitions,
    maxCases: sweep.maxCases,
    plannedCases: sweep.plannedCases,
    ranking,
  };
}

function buildSweepRanking(
  caseOutcomes: readonly StoredCaseOutcome[],
): SweepRankingEntry[] {
  const completed = caseOutcomes
    .filter((caseOutcome) => {
      return caseOutcome.status === "completed";
    })
    .sort((left, right) => {
      // Keep ranking deterministic even if a future producer supplies
      // higher-precision values than the orchestrator's current 3-decimal TPS.
      const leftTokensPerSecond = normalizeRankingTokensPerSecond(left.tokensPerSecond);
      const rightTokensPerSecond = normalizeRankingTokensPerSecond(right.tokensPerSecond);
      if (leftTokensPerSecond !== rightTokensPerSecond) {
        return rightTokensPerSecond - leftTokensPerSecond;
      }

      if (left.latencyMs !== right.latencyMs) {
        return left.latencyMs - right.latencyMs;
      }

      return compareLexicographic(left.caseId, right.caseId);
    });

  const failed = caseOutcomes
    .filter((caseOutcome) => {
      return caseOutcome.status === "failed";
    })
    .sort((left, right) => {
      return compareLexicographic(left.caseId, right.caseId);
    });

  const ranking: SweepRankingEntry[] = [];

  let rank = 1;
  for (const caseOutcome of completed) {
    ranking.push({
      rank,
      caseId: caseOutcome.caseId,
      status: "completed",
      tokensPerSecond: caseOutcome.tokensPerSecond,
      latencyMs: caseOutcome.latencyMs,
    });
    rank += 1;
  }

  for (const caseOutcome of failed) {
    ranking.push({
      rank,
      caseId: caseOutcome.caseId,
      status: "failed",
    });
    rank += 1;
  }

  return ranking;
}

function compareLexicographic(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function normalizeRankingTokensPerSecond(tokensPerSecond: number): number {
  return Number(tokensPerSecond.toFixed(3));
}
