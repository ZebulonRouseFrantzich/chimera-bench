/**
 * Case execution bridge for llama-server chat-completions calls.
 *
 * This module converts a normalized `EngineCaseConfig` into an OpenAI-compatible
 * `/v1/chat/completions` request and maps the response back into
 * `EngineCaseResult` for run persistence.
 */
import type {
  EngineCaseConfig,
  EngineCaseResult,
  EngineRuntimeContext,
} from "../engine-plugin.ts";
import type {
  LlamaServerRunState,
  StarterLlamaCppPluginDependencies,
} from "./types.ts";
import { RESERVED_REQUEST_PARAM_KEYS } from "./constants.ts";
import {
  buildChatCompletionsUrl,
  createCodeError,
  redactSecret,
} from "./utils.ts";

export async function executeLlamaServerCase(input: {
  context: EngineRuntimeContext;
  caseConfig: EngineCaseConfig;
  runStates: ReadonlyMap<string, LlamaServerRunState>;
  dependencies: StarterLlamaCppPluginDependencies;
}): Promise<EngineCaseResult> {
  const runState = input.runStates.get(input.context.runId);
  if (!runState) {
    throw createCodeError(
      "ENGINE_EXECUTION_FAILED",
      `llama-server runtime is not active for run '${input.context.runId}'. Call start() first.`,
    );
  }

  const {
    sanitizedRequestParams,
    removedReservedRequestParamKeys,
  } = sanitizeCaseRequestParams(input.caseConfig.requestParams);
  if (removedReservedRequestParamKeys.length > 0) {
    input.context.emitDiagnostic?.({
      level: "warn",
      message: "Removed reserved request parameter keys before llama-server execution.",
      data: {
        runId: input.context.runId,
        caseId: input.caseConfig.caseId,
        keys: removedReservedRequestParamKeys,
      },
    });
  }

  const caseExecutionUrl = buildChatCompletionsUrl(runState.healthUrl);
  const requestBody = {
    ...sanitizedRequestParams,
    messages: input.caseConfig.messages,
    stream: false,
  };

  let response: Response;
  try {
    response = await input.dependencies.fetch(caseExecutionUrl, {
      method: "POST",
      headers: {
        ...runState.healthRequestHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: input.context.abortSignal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }

    const reason = error instanceof Error ? error.message : String(error);
    input.context.emitDiagnostic?.({
      level: "warn",
      message: "llama-server case execution request failed.",
      data: {
        runId: input.context.runId,
        caseId: input.caseConfig.caseId,
        reason: redactSecret(reason, runState.apiKey),
      },
    });

    throw createCodeError(
      "ENGINE_EXECUTION_FAILED",
      "llama-server case execution request failed.",
    );
  }

  let responseBodyText = "";
  let responseBodyBytes = 0;
  try {
    const responseBody = await readResponseBodyWithLimit(
      response,
      input.dependencies.maxCaseResponseBytes,
    );
    responseBodyText = responseBody.text;
    responseBodyBytes = responseBody.byteLength;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    if (error instanceof ResponseBodyTooLargeError) {
      input.context.emitDiagnostic?.({
        level: "warn",
        message: "llama-server case execution response exceeded configured size limit.",
        data: {
          runId: input.context.runId,
          caseId: input.caseConfig.caseId,
          status: response.status,
          maxCaseResponseBytes: input.dependencies.maxCaseResponseBytes,
          observedResponseBytes: error.observedBytes,
        },
      });

      throw createCodeError(
        "ENGINE_EXECUTION_FAILED",
        `llama-server case execution response exceeded ${input.dependencies.maxCaseResponseBytes} bytes.`,
      );
    }

    const reason = error instanceof Error ? error.message : String(error);
    input.context.emitDiagnostic?.({
      level: "warn",
      message: "Failed to read llama-server case execution response body.",
      data: {
        runId: input.context.runId,
        caseId: input.caseConfig.caseId,
        status: response.status,
        reason: redactSecret(reason, runState.apiKey),
      },
    });

    throw createCodeError(
      "ENGINE_EXECUTION_FAILED",
      "Failed to read llama-server case execution response body.",
    );
  }

  if (!response.ok) {
    input.context.emitDiagnostic?.({
      level: "warn",
      message: "llama-server returned a non-success response for case execution.",
      data: {
        runId: input.context.runId,
        caseId: input.caseConfig.caseId,
        status: response.status,
        responseBodyBytes,
      },
    });

    throw createCodeError(
      "ENGINE_EXECUTION_FAILED",
      `llama-server case execution failed with HTTP ${response.status}.`,
    );
  }

  if (responseBodyBytes > input.dependencies.maxCaseResponseBytes) {
    throw createCodeError(
      "ENGINE_EXECUTION_FAILED",
      `llama-server case execution response exceeded ${input.dependencies.maxCaseResponseBytes} bytes.`,
    );
  }

  let rawResponse: unknown;
  try {
    rawResponse = JSON.parse(responseBodyText);
  } catch {
    input.context.emitDiagnostic?.({
      level: "warn",
      message: "llama-server returned a non-JSON case execution response.",
      data: {
        runId: input.context.runId,
        caseId: input.caseConfig.caseId,
        responseBodyBytes,
      },
    });

    throw createCodeError(
      "ENGINE_EXECUTION_FAILED",
      "llama-server case execution returned invalid JSON.",
    );
  }

  const outputText = extractAssistantOutputText(rawResponse);
  if (outputText === null) {
    input.context.emitDiagnostic?.({
      level: "warn",
      message: "llama-server case execution response did not include assistant text output.",
      data: {
        runId: input.context.runId,
        caseId: input.caseConfig.caseId,
      },
    });

    throw createCodeError(
      "ENGINE_EXECUTION_FAILED",
      "llama-server case execution response did not include assistant output.",
    );
  }

  return {
    outputText,
    rawResponse,
  };
}

function sanitizeCaseRequestParams(requestParams: Record<string, unknown>): {
  sanitizedRequestParams: Record<string, unknown>;
  removedReservedRequestParamKeys: string[];
} {
  const sanitizedRequestParams: Record<string, unknown> = {};
  const removedReservedRequestParamKeys: string[] = [];

  for (const [key, value] of Object.entries(requestParams)) {
    if (RESERVED_REQUEST_PARAM_KEYS.has(key)) {
      removedReservedRequestParamKeys.push(key);
      continue;
    }

    sanitizedRequestParams[key] = value;
  }

  removedReservedRequestParamKeys.sort();
  return {
    sanitizedRequestParams,
    removedReservedRequestParamKeys,
  };
}

function extractAssistantOutputText(rawResponse: unknown): string | null {
  if (!isRecord(rawResponse)) {
    return null;
  }

  const choices = rawResponse.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }

  const firstChoice = choices[0];
  if (!isRecord(firstChoice)) {
    return null;
  }

  const message = firstChoice.message;
  if (isRecord(message)) {
    const role = typeof message.role === "string" ? message.role : null;
    const messageContent = normalizeAssistantMessageContent(message.content);
    if (messageContent !== null && (role === null || role === "assistant")) {
      return messageContent;
    }
  }

  if (typeof firstChoice.text === "string") {
    return firstChoice.text;
  }

  return null;
}

function normalizeAssistantMessageContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const textSegments = content.flatMap((segment) => {
    if (isRecord(segment) && typeof segment.text === "string") {
      return [segment.text];
    }

    return [];
  });
  if (textSegments.length === 0) {
    return null;
  }

  return textSegments.join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

class ResponseBodyTooLargeError extends Error {
  constructor(
    readonly maxBytes: number,
    readonly observedBytes: number,
  ) {
    super(`Case response exceeded ${maxBytes} bytes.`);
    this.name = "ResponseBodyTooLargeError";
  }
}

async function readResponseBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<{
  text: string;
  byteLength: number;
}> {
  const declaredContentLength = parseContentLengthHeader(response.headers.get("content-length"));
  if (declaredContentLength !== null && declaredContentLength > maxBytes) {
    throw new ResponseBodyTooLargeError(maxBytes, declaredContentLength);
  }

  if (!response.body) {
    return {
      text: "",
      byteLength: 0,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let observedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      observedBytes += value.byteLength;
      if (observedBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Best-effort stream cancellation; preserve the limit error.
        }
        throw new ResponseBodyTooLargeError(maxBytes, observedBytes);
      }

      chunks.push(decoder.decode(value, { stream: true }));
    }

    chunks.push(decoder.decode());
    return {
      text: chunks.join(""),
      byteLength: observedBytes,
    };
  } finally {
    reader.releaseLock();
  }
}

function parseContentLengthHeader(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}
