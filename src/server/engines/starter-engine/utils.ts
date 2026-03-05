/**
 * Shared utility helpers for starter-engine runtime wiring.
 *
 * Covers launch-arg parsing, endpoint construction, redaction, and common
 * runtime type guards used across startup/execution modules.
 */
import { REDACTED_VALUE } from "./constants.ts";

export function buildHealthUrl(launchArgs: string[]): string {
  const host = extractRequiredFlagValue(launchArgs, "--host");
  const port = parseFlagIntValue(launchArgs, "--port");
  if (port === null) {
    throw new Error("llama.cpp launch config is missing a valid --port value.");
  }

  return `http://${host}:${port}/health`;
}

export function buildChatCompletionsUrl(healthUrl: string): string {
  const endpoint = new URL(healthUrl);
  endpoint.pathname = "/v1/chat/completions";
  // Drop search/hash from the health probe URL so request shaping is stable and
  // never forwards accidental probe-specific suffixes to the generation path.
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString();
}

export function buildTokenizeUrl(healthUrl: string): string {
  const endpoint = new URL(healthUrl);
  endpoint.pathname = "/tokenize";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString();
}

export function buildHealthRequestHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

export function parseFlagIntValue(args: string[], flag: string): number | null {
  const value = extractFlagValue(args, flag);
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

export function extractRequiredFlagValue(args: string[], flag: string): string {
  const value = extractFlagValue(args, flag);
  if (!value) {
    throw new Error(`llama.cpp launch config is missing required flag '${flag}'.`);
  }

  return value;
}

export function extractFlagValue(args: string[], flag: string): string | null {
  let latestMatch: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) {
      continue;
    }

    if (argument === flag) {
      const value = args[index + 1];
      latestMatch = value ?? null;
      continue;
    }

    if (argument.startsWith(`${flag}=`)) {
      latestMatch = argument.slice(flag.length + 1);
    }
  }

  return latestMatch;
}

export function extractFlagToken(argument: string): string {
  const equalsIndex = argument.indexOf("=");
  if (equalsIndex === -1) {
    return argument;
  }

  return argument.slice(0, equalsIndex);
}

export function replaceRequiredFlagValue(
  args: string[],
  flag: string,
  replacementValue: string,
): string[] {
  const replacedArgs = [...args];

  for (let index = 0; index < replacedArgs.length; index += 1) {
    const argument = replacedArgs[index];
    if (!argument) {
      continue;
    }

    if (argument === flag) {
      if (index + 1 >= replacedArgs.length) {
        break;
      }

      replacedArgs[index + 1] = replacementValue;
      return replacedArgs;
    }

    if (argument.startsWith(`${flag}=`)) {
      replacedArgs[index] = `${flag}=${replacementValue}`;
      return replacedArgs;
    }
  }

  throw new Error(`Cannot replace '${flag}' because the launch config does not include it.`);
}

export function redactLaunchArgs(args: string[]): string[] {
  const redactedArgs = [...args];

  for (let index = 0; index < redactedArgs.length; index += 1) {
    const argument = redactedArgs[index];
    if (!argument) {
      continue;
    }

    if (argument === "--api-key" || argument === "--api_key") {
      if (index + 1 < redactedArgs.length) {
        redactedArgs[index + 1] = REDACTED_VALUE;
      }
      continue;
    }

    if (argument.startsWith("--api-key=") || argument.startsWith("--api_key=")) {
      const separatorIndex = argument.indexOf("=");
      const prefix = separatorIndex === -1 ? argument : argument.slice(0, separatorIndex);
      redactedArgs[index] = `${prefix}=${REDACTED_VALUE}`;
    }
  }

  return redactedArgs;
}

export function redactSecret(input: string, secret: string): string {
  if (secret.length === 0 || input.length === 0) {
    return input;
  }

  return input.split(secret).join(REDACTED_VALUE);
}

export function normalizeIssueMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

export function createCodeError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Error & {
  code: string;
  details?: Record<string, unknown>;
} {
  const error = new Error(message) as Error & {
    code: string;
    details?: Record<string, unknown>;
  };

  error.code = code;
  if (details) {
    error.details = details;
  }

  return error;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

export function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  return new Error(`Unexpected non-error value: ${String(value)}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
