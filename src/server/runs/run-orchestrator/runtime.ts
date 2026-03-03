/**
 * Runtime-level helpers for run orchestration.
 *
 * This module centralizes timeout/abort utilities and error normalization so
 * orchestration control flow stays focused on lifecycle transitions.
 */
import {
  sanitizeControlCharacters,
  sanitizeErrorCode,
} from "../../http/sanitize.ts";
import type { RunFailureDetails } from "../in-memory-run-store/index.ts";

const MAX_DETAIL_DEPTH = 4;
const MAX_DETAIL_ITEMS = 32;
const MAX_DETAIL_STRING_CHARS = 1_024;
const SENSITIVE_DETAIL_KEY_PATTERN =
  /(password|secret|token|api[_-]?key|authorization|cookie)/i;

export class RunCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunCancelledError";
  }
}

export class RunTimeoutExceededError extends Error {
  constructor(timeoutMs: number) {
    super(`Run exceeded timeout of ${timeoutMs}ms.`);
    this.name = "RunTimeoutExceededError";
  }
}

export class CaseExecutionTimeoutError extends Error {
  constructor(caseId: string, timeoutMs: number) {
    super(`Case '${caseId}' exceeded timeout of ${timeoutMs}ms.`);
    this.name = "CaseExecutionTimeoutError";
  }
}

export class FatalRunExecutionError extends Error {
  constructor(readonly failure: RunFailureDetails) {
    super(failure.message);
    this.name = "FatalRunExecutionError";
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function isFatalEngineFailure(error: unknown): boolean {
  if (!isCodeError(error)) {
    return false;
  }

  return error.code.startsWith("ENGINE_");
}

export function toRunFailure(error: unknown): RunFailureDetails {
  if (error instanceof RunTimeoutExceededError) {
    return {
      code: "RUN_TIMEOUT_EXCEEDED",
      message: sanitizeControlCharacters(error.message),
    };
  }

  if (error instanceof CaseExecutionTimeoutError) {
    return {
      code: "RUN_CASE_TIMEOUT",
      message: sanitizeControlCharacters(error.message),
    };
  }

  if (isCodeError(error)) {
    return {
      code: sanitizeErrorCode(error.code, "RUN_CASE_FAILED"),
      message: sanitizeControlCharacters(error.message),
      ...(error.details
        ? {
            details: sanitizeFailureDetails(error.details),
          }
        : {}),
    };
  }

  if (error instanceof Error) {
    return {
      code: "RUN_CASE_FAILED",
      message: sanitizeControlCharacters(error.message),
    };
  }

  return {
    code: "RUN_CASE_FAILED",
    message: "Run execution failed with an unknown error.",
  };
}

export async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  timeoutFactory: () => Error,
  onTimeout?: () => void,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          try {
            onTimeout?.();
          } catch {
            // Best-effort timeout side effects should not mask timeout errors.
          }
          reject(timeoutFactory());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export function linkAbortSignal(
  parentSignal: AbortSignal,
  childController: AbortController,
): () => void {
  if (parentSignal.aborted) {
    childController.abort();
    return () => {
      return;
    };
  }

  const onAbort = () => {
    childController.abort();
  };

  parentSignal.addEventListener("abort", onAbort, {
    once: true,
  });

  return () => {
    parentSignal.removeEventListener("abort", onAbort);
  };
}

function isCodeError(
  value: unknown,
): value is {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybeError = value as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };

  return typeof maybeError.code === "string" && typeof maybeError.message === "string";
}

function sanitizeFailureDetails(
  details: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeDetailRecord(details, 0);
}

function sanitizeDetailRecord(
  details: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  if (depth >= MAX_DETAIL_DEPTH) {
    return {
      truncated: true,
    };
  }

  const sanitized: Record<string, unknown> = {};
  const entries = Object.entries(details);
  const limitedEntries = entries.slice(0, MAX_DETAIL_ITEMS);

  for (const [rawKey, value] of limitedEntries) {
    const key = sanitizeDetailString(rawKey);
    if (key.length === 0) {
      continue;
    }

    if (SENSITIVE_DETAIL_KEY_PATTERN.test(key)) {
      sanitized[key] = "[REDACTED]";
      continue;
    }

    sanitized[key] = sanitizeDetailValue(value, depth);
  }

  if (entries.length > MAX_DETAIL_ITEMS) {
    sanitized.truncated = true;
  }

  return sanitized;
}

function sanitizeDetailValue(value: unknown, depth: number): unknown {
  if (depth >= MAX_DETAIL_DEPTH) {
    return "[TRUNCATED]";
  }

  if (typeof value === "string") {
    return sanitizeDetailString(value);
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    const limitedValues = value.slice(0, MAX_DETAIL_ITEMS);
    const sanitizedValues = limitedValues.map((entry) => {
      return sanitizeDetailValue(entry, depth + 1);
    });
    if (value.length > MAX_DETAIL_ITEMS) {
      sanitizedValues.push("[TRUNCATED]");
    }
    return sanitizedValues;
  }

  if (value && typeof value === "object") {
    return sanitizeDetailRecord(value as Record<string, unknown>, depth + 1);
  }

  return sanitizeDetailString(String(value));
}

function sanitizeDetailString(value: string): string {
  const sanitized = sanitizeControlCharacters(value);
  if (sanitized.length <= MAX_DETAIL_STRING_CHARS) {
    return sanitized;
  }

  return `${sanitized.slice(0, MAX_DETAIL_STRING_CHARS)}...`;
}
