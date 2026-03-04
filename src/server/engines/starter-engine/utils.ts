import { REDACTED_VALUE } from "./constants.ts";

export function buildHealthUrl(launchArgs: string[]): string {
  const host = extractRequiredFlagValue(launchArgs, "--host");
  const port = parseFlagIntValue(launchArgs, "--port");
  if (port === null) {
    throw new Error("llama.cpp launch config is missing a valid --port value.");
  }

  return `http://${host}:${port}/health`;
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
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) {
      continue;
    }

    if (argument === flag) {
      const value = args[index + 1];
      return value ?? null;
    }

    if (argument.startsWith(`${flag}=`)) {
      return argument.slice(flag.length + 1);
    }
  }

  return null;
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
