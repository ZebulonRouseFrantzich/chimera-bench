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
  isAbortError,
  isRecord,
  redactSecret,
} from "./utils.ts";
import {
  readResponseBodyWithLimit,
  ResponseBodyTooLargeError,
} from "./http-response-limit.ts";
import { assertPromptFitsContextWindow } from "./prompt-fit-preflight.ts";
import {
  parsePromptTooLargeError,
  sanitizeChatCompletionRawResponse,
} from "./chat-completions-response.ts";

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

  await assertPromptFitsContextWindow({
    context: input.context,
    caseConfig: input.caseConfig,
    runState,
    dependencies: input.dependencies,
  });

  const caseExecutionUrl = buildChatCompletionsUrl(runState.healthUrl);
  const requestBody = {
    ...sanitizedRequestParams,
    model: runState.modelIdentifier,
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
    if (isAbortError(error)) {
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

    const promptTooLarge = parsePromptTooLargeError(response.status, responseBodyText);
    if (promptTooLarge) {
      throw createCodeError(
        "VALIDATION_PROMPT_TOO_LARGE",
        promptTooLarge.message,
        promptTooLarge.details,
      );
    }

    throw createCodeError(
      "ENGINE_EXECUTION_FAILED",
      `llama-server case execution failed with HTTP ${response.status}.`,
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
    rawResponse: sanitizeChatCompletionRawResponse(rawResponse),
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

  // Keep OpenAI-style content part ordering exactly as emitted; segments are
  // already pre-delimited text fragments and should not receive separators.
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
