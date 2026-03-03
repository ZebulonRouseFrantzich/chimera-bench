import type { EngineRunConfigValidationFailure } from "../../engines/engine-plugin.ts";
import {
  sanitizeControlCharacters,
  sanitizeErrorCode,
} from "../../http/sanitize.ts";

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

function sanitizeIssuePath(path: string | undefined): string {
  const sanitized = sanitizeControlCharacters(path ?? "(root)");
  return sanitized.length > 0 ? sanitized : "(root)";
}
