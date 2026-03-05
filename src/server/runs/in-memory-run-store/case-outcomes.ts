import {
  estimateTokenCount,
  estimateTokensPerSecond,
} from "../token-estimation.ts";
import {
  cloneRunFailure,
  normalizeNonNegativeInteger,
  reconcileTotalCases,
} from "./record-utils.ts";
import type {
  RunFailureDetails,
  RunRecord,
} from "./types.ts";

interface RecordCaseCompletedInput {
  caseId: string;
  promptId: string;
  index: number;
  contextTokens: number;
  latencyMs: number;
  outputText: string;
  engineArgs: readonly string[];
  requestParams: Record<string, unknown>;
  rawResponse?: unknown;
}

interface RecordCaseFailedInput {
  caseId: string;
  promptId: string;
  index: number;
  contextTokens: number;
  latencyMs: number;
  engineArgs: readonly string[];
  requestParams: Record<string, unknown>;
  error: RunFailureDetails;
}

export function recordCompletedCaseOutcome(
  runId: string,
  run: RunRecord,
  input: RecordCaseCompletedInput,
): void {
  const latencyMs = normalizeNonNegativeInteger(input.latencyMs, 0);
  const outputTokens =
    extractUsageCompletionTokens(input.rawResponse) ?? estimateTokenCount(input.outputText);

  run.caseOutcomes.push({
    runId,
    caseId: input.caseId,
    promptId: input.promptId,
    index: input.index,
    status: "completed",
    contextTokens: normalizeNonNegativeInteger(input.contextTokens, 0),
    engineArgs: [...input.engineArgs],
    requestParams: {
      ...input.requestParams,
    },
    latencyMs,
    ttftMs: null,
    outputTokens,
    // Keep v0.0.1 throughput semantics end-to-end: output tokens over full
    // case-execution latency (including prompt processing and network overhead).
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
  reconcileTotalCases(run);
}

export function recordFailedCaseOutcome(
  runId: string,
  run: RunRecord,
  input: RecordCaseFailedInput,
): RunFailureDetails {
  const sanitizedError = cloneRunFailure(input.error);

  run.caseOutcomes.push({
    runId,
    caseId: input.caseId,
    promptId: input.promptId,
    index: input.index,
    status: "failed",
    contextTokens: normalizeNonNegativeInteger(input.contextTokens, 0),
    engineArgs: [...input.engineArgs],
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
  reconcileTotalCases(run);

  return sanitizedError;
}

function extractUsageCompletionTokens(rawResponse: unknown): number | null {
  if (!rawResponse || typeof rawResponse !== "object") {
    return null;
  }

  const usage = (rawResponse as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const completionTokens = (usage as Record<string, unknown>).completion_tokens;
  if (typeof completionTokens !== "number" || !Number.isFinite(completionTokens)) {
    return null;
  }

  return normalizeNonNegativeInteger(completionTokens, 0);
}
