import { toError } from "../../../error-utils.ts";
import type { EngineRunConfigValidationFailure } from "../../../engines/engine-plugin.ts";
import {
  sanitizeControlCharacters,
  sanitizeErrorCode,
} from "../../../http/sanitize.ts";
import type {
  InMemoryRunStore,
  RunFailureDetails,
} from "../../in-memory-run-store/index.ts";
import type { ExpandedSweepCase } from "../../sweep-expansion.ts";
import { estimateTokenCount } from "../../token-estimation.ts";

export function failSweepRunWithRemainingCases(input: {
  runStore: InMemoryRunStore;
  runId: string;
  sweepCases: readonly ExpandedSweepCase[];
  startIndex: number;
  failure: RunFailureDetails;
  nowIso: string;
}): void {
  if (input.startIndex === 0) {
    input.runStore.markRunRunning(input.runId, input.nowIso);
  }

  for (let index = input.startIndex; index < input.sweepCases.length; index += 1) {
    const sweepCase = input.sweepCases[index];
    if (!sweepCase) {
      continue;
    }

    input.runStore.recordCaseFailed(input.runId, {
      caseId: sweepCase.caseId,
      promptId: sweepCase.promptId,
      index,
      contextTokens: estimateTokenCount(sweepCase.prompt),
      latencyMs: 0,
      engineArgs: sweepCase.engineArgs,
      requestParams: sweepCase.requestParams,
      error: input.failure,
    });
  }

  input.runStore.failRun(input.runId, input.nowIso, input.failure);
}

export function toSweepCaseValidationFailure(
  failure: EngineRunConfigValidationFailure,
): RunFailureDetails {
  const issues =
    failure.issues
      ?.map((issue) => ({
        code: sanitizeErrorCode(issue.code, "VALIDATION_SWEEP_INVALID"),
        message: sanitizeControlCharacters(issue.message),
        path: sanitizeSweepIssuePath(issue.path),
      }))
      .filter((issue) => issue.code.length > 0 && issue.message.length > 0) ?? [];

  return {
    code: sanitizeErrorCode(failure.code, "VALIDATION_SWEEP_INVALID"),
    message: sanitizeControlCharacters(failure.message),
    ...(issues.length > 0
      ? {
          details: {
            issues,
          },
        }
      : {}),
  };
}

export function toUnexpectedSweepValidationFailure(error: unknown): RunFailureDetails {
  return {
    code: "ENGINE_VALIDATION_FAILED",
    message: "Engine case validation failed due to an unexpected internal error.",
    details: {
      reason: sanitizeControlCharacters(toError(error).message),
    },
  };
}

function sanitizeSweepIssuePath(path: string | undefined): string {
  const sanitized = sanitizeControlCharacters(path ?? "(root)");
  return sanitized.length > 0 ? sanitized : "(root)";
}
