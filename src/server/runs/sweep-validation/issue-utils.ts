import {
  sanitizeControlCharacters,
  sanitizeErrorCode,
} from "../../http/sanitize.ts";
import type { SweepValidationIssue } from "./types.ts";

export function createSweepIssue(input: {
  code: string;
  message: string;
  path: string;
}): SweepValidationIssue {
  return {
    code: sanitizeErrorCode(input.code, "VALIDATION_SWEEP_INVALID"),
    message: sanitizeControlCharacters(input.message),
    path: sanitizePath(input.path),
  };
}

function sanitizePath(path: string): string {
  const sanitizedPath = sanitizeControlCharacters(path);
  return sanitizedPath.length > 0 ? sanitizedPath : "(root)";
}
