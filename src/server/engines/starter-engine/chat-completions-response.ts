/**
 * Helpers for interpreting and sanitizing llama-server chat-completions
 * responses.
 *
 * Keeps persisted `rawResponse` bounded to an allowlisted subset and recognizes
 * upstream context-overflow error payloads for stable local failure mapping.
 */
import { isRecord } from "./utils.ts";

interface ParsedPromptTooLargeError {
  message: string;
  details: Record<string, unknown>;
}

export function parsePromptTooLargeError(
  status: number,
  responseBodyText: string,
): ParsedPromptTooLargeError | null {
  const parsedBody = safeParseJson(responseBodyText);
  if (!isRecord(parsedBody)) {
    return null;
  }

  const errorPayload = parsedBody.error;
  if (!isRecord(errorPayload)) {
    return null;
  }

  const upstreamType = typeof errorPayload.type === "string" ? errorPayload.type : null;
  const upstreamMessage =
    typeof errorPayload.message === "string" ? errorPayload.message : "";
  const looksLikeContextOverflow =
    upstreamType === "exceed_context_size_error" ||
    upstreamMessage.includes("exceeds the available context size");
  if (!looksLikeContextOverflow) {
    return null;
  }

  const promptCount = parseNonNegativeInteger(errorPayload.n_prompt_tokens);
  const contextWindow = parsePositiveInteger(errorPayload.n_ctx);

  const details: Record<string, unknown> = {
    status,
    ...(upstreamType
      ? {
          upstreamType,
        }
      : {}),
    ...(promptCount !== null
      ? {
          promptCount,
        }
      : {}),
    ...(contextWindow !== null
      ? {
          contextWindow,
        }
      : {}),
  };

  return {
    message:
      promptCount !== null && contextWindow !== null
        ? `Prompt is too large for configured context window (${promptCount} > ${contextWindow}).`
        : "Prompt is too large for configured context window.",
    details,
  };
}

export function sanitizeChatCompletionRawResponse(rawResponse: unknown): Record<string, unknown> {
  if (!isRecord(rawResponse)) {
    return {};
  }

  const sanitized: Record<string, unknown> = {};

  copyStringField(rawResponse, sanitized, "id");
  copyStringField(rawResponse, sanitized, "object");
  copyNumberField(rawResponse, sanitized, "created");
  copyStringField(rawResponse, sanitized, "model");
  copyStringField(rawResponse, sanitized, "system_fingerprint");

  const choices = sanitizeChoices(rawResponse.choices);
  if (choices.length > 0) {
    sanitized.choices = choices;
  }

  const usage = sanitizeUsage(rawResponse.usage);
  if (usage) {
    sanitized.usage = usage;
  }

  return sanitized;
}

function sanitizeChoices(choicesValue: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(choicesValue)) {
    return [];
  }

  const choices: Array<Record<string, unknown>> = [];
  for (const choice of choicesValue) {
    if (!isRecord(choice)) {
      continue;
    }

    const sanitizedChoice: Record<string, unknown> = {};
    copyNumberField(choice, sanitizedChoice, "index");
    copyStringField(choice, sanitizedChoice, "finish_reason");
    copyStringField(choice, sanitizedChoice, "text");

    const message = sanitizeMessage(choice.message);
    if (message) {
      sanitizedChoice.message = message;
    }

    if (Object.keys(sanitizedChoice).length === 0) {
      continue;
    }

    choices.push(sanitizedChoice);
  }

  return choices;
}

function sanitizeMessage(messageValue: unknown): Record<string, unknown> | null {
  if (!isRecord(messageValue)) {
    return null;
  }

  const message: Record<string, unknown> = {};
  copyStringField(messageValue, message, "role");

  const content = messageValue.content;
  if (typeof content === "string") {
    message.content = content;
  } else if (Array.isArray(content)) {
    const contentParts = content
      .map((entry) => {
        if (!isRecord(entry)) {
          return null;
        }

        const text = typeof entry.text === "string" ? entry.text : null;
        if (text === null) {
          return null;
        }

        return {
          ...(typeof entry.type === "string"
            ? {
                type: entry.type,
              }
            : {}),
          text,
        };
      })
      .filter((entry) => {
        return entry !== null;
      });

    if (contentParts.length > 0) {
      message.content = contentParts;
    }
  }

  return Object.keys(message).length > 0 ? message : null;
}

function sanitizeUsage(usageValue: unknown): Record<string, unknown> | null {
  if (!isRecord(usageValue)) {
    return null;
  }

  const usage: Record<string, unknown> = {};
  copyNumberField(usageValue, usage, "prompt_tokens");
  copyNumberField(usageValue, usage, "completion_tokens");
  copyNumberField(usageValue, usage, "total_tokens");

  return Object.keys(usage).length > 0 ? usage : null;
}

function copyStringField(
  source: Record<string, unknown>,
  destination: Record<string, unknown>,
  key: string,
): void {
  const value = source[key];
  if (typeof value === "string") {
    destination[key] = value;
  }
}

function copyNumberField(
  source: Record<string, unknown>,
  destination: Record<string, unknown>,
  key: string,
): void {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    destination[key] = value;
  }
}

function parseNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.floor(value);
}

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.floor(value);
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
