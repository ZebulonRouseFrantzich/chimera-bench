import { z } from "zod";
import { sanitizeControlCharacters } from "./sanitize.ts";

export interface ValidationErrorIssue {
  code: string;
  message: string;
  path: string;
}

export function formatValidationIssues(
  issues: readonly z.ZodIssue[],
): ValidationErrorIssue[] {
  return issues.map((issue) => ({
    code: issue.code,
    message: sanitizeControlCharacters(issue.message),
    path: sanitizeIssuePath(issue.path),
  }));
}

function sanitizeIssuePath(path: readonly PropertyKey[]): string {
  const formattedPath = formatIssuePath(path);
  const sanitizedPath = sanitizeControlCharacters(formattedPath);
  return sanitizedPath.length > 0 ? sanitizedPath : "(root)";
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return "(root)";
  }

  let formatted = "";

  for (const segment of path) {
    if (typeof segment === "number") {
      formatted += `[${segment}]`;
      continue;
    }

    const normalized =
      typeof segment === "string" ? segment : String(segment.description ?? segment);

    if (!normalized) {
      continue;
    }

    if (formatted.length === 0) {
      formatted = normalized;
    } else {
      formatted += `.${normalized}`;
    }
  }

  return formatted.length > 0 ? formatted : "(root)";
}
