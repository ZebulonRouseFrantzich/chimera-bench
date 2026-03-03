import type { EngineRunConfigValidationFailure } from "../engines/engine-plugin.ts";
import {
  sanitizeControlCharacters,
  sanitizeErrorCode,
} from "../http/sanitize.ts";
import type { InMemoryRunStore } from "../runs/in-memory-run-store.ts";
import type { RunArtifactStore } from "../runs/run-artifact-store.ts";

export function buildValidationFailurePayload(
  failure: EngineRunConfigValidationFailure,
): {
  code: string;
  message: string;
  details?: {
    issues: Array<{
      code: string;
      message: string;
      path: string;
    }>;
  };
} {
  const issues =
    failure.issues
      ?.map((issue) => ({
        code: sanitizeErrorCode(issue.code, "VALIDATION_ENGINE_OPTIONS_INVALID"),
        message: sanitizeControlCharacters(issue.message),
        path: sanitizeIssuePath(issue.path),
      }))
      .filter((issue) => issue.code.length > 0 && issue.message.length > 0) ?? [];

  return {
    code: sanitizeErrorCode(failure.code, "VALIDATION_ENGINE_OPTIONS_INVALID"),
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

export function isTerminalRunStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export async function persistRunArtifact(
  runId: string,
  runStore: InMemoryRunStore,
  runArtifacts: RunArtifactStore,
): Promise<void> {
  const result = runStore.getRunResult(runId);
  if (!result) {
    return;
  }

  await runArtifacts.writeResult(runId, result);
}

function sanitizeIssuePath(path: string | undefined): string {
  const sanitized = sanitizeControlCharacters(path ?? "(root)");
  return sanitized.length > 0 ? sanitized : "(root)";
}
