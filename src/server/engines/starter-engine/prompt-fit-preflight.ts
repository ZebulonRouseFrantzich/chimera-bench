/**
 * Prompt token-fit preflight for per-case llama-server execution.
 *
 * This module uses `/tokenize` with bounded response handling to estimate
 * prompt token usage before dispatching `/v1/chat/completions`, then fails fast
 * when the prompt cannot fit within the configured `--ctx-size` budget.
 */
import type {
  EngineCaseConfig,
  EngineRuntimeContext,
} from "../engine-plugin.ts";
import type {
  LlamaServerRunState,
  StarterLlamaCppPluginDependencies,
} from "./types.ts";
import {
  buildTokenizeUrl,
  createCodeError,
  isAbortError,
  isRecord,
  redactSecret,
} from "./utils.ts";
import {
  readResponseBodyWithLimit,
  ResponseBodyTooLargeError,
} from "./http-response-limit.ts";

// Conservative guardrail for chat wrapper/system framing overhead so v0.0.1
// fails fast before upstream context overflow. Future scenario/prompt
// calibration policies may tune this value.
const CHAT_COMPLETIONS_TOKEN_OVERHEAD_TOKENS = 1_024;

export async function assertPromptFitsContextWindow(input: {
  context: EngineRuntimeContext;
  caseConfig: EngineCaseConfig;
  runState: LlamaServerRunState;
  dependencies: StarterLlamaCppPluginDependencies;
}): Promise<void> {
  const contextWindowTokens = input.runState.contextWindowTokens;
  if (contextWindowTokens === null || contextWindowTokens <= 0) {
    if (!input.runState.promptFitPreflightSkipLogged) {
      input.context.emitDiagnostic?.({
        level: "info",
        message:
          "Skipping prompt token preflight because launch args did not include an explicit --ctx-size.",
        data: {
          runId: input.context.runId,
          caseId: input.caseConfig.caseId,
        },
      });
      input.runState.promptFitPreflightSkipLogged = true;
    }

    return;
  }

  const promptTokenCount = await fetchPromptTokenCount(input);
  const estimatedRequiredPromptTokens =
    promptTokenCount + CHAT_COMPLETIONS_TOKEN_OVERHEAD_TOKENS;
  if (estimatedRequiredPromptTokens <= contextWindowTokens) {
    return;
  }

  input.context.emitDiagnostic?.({
    level: "warn",
    message: "Prompt exceeds configured context window for case execution.",
    data: {
      runId: input.context.runId,
      caseId: input.caseConfig.caseId,
      promptTokenCount,
      estimatedChatOverheadTokens: CHAT_COMPLETIONS_TOKEN_OVERHEAD_TOKENS,
      estimatedRequiredPromptTokens,
      contextWindowTokens,
    },
  });

  throw createCodeError(
    "VALIDATION_PROMPT_TOO_LARGE",
    `Prompt does not fit configured --ctx-size ${contextWindowTokens} for case '${input.caseConfig.caseId}'.`,
    {
      promptCount: promptTokenCount,
      overheadCount: CHAT_COMPLETIONS_TOKEN_OVERHEAD_TOKENS,
      requiredCount: estimatedRequiredPromptTokens,
      contextWindow: contextWindowTokens,
    },
  );
}

async function fetchPromptTokenCount(input: {
  context: EngineRuntimeContext;
  caseConfig: EngineCaseConfig;
  runState: LlamaServerRunState;
  dependencies: StarterLlamaCppPluginDependencies;
}): Promise<number> {
  const tokenizeUrl = buildTokenizeUrl(input.runState.healthUrl);

  let response: Response;
  try {
    response = await input.dependencies.fetch(tokenizeUrl, {
      method: "POST",
      headers: {
        ...input.runState.healthRequestHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: input.caseConfig.prompt,
        add_special: true,
      }),
      signal: input.context.abortSignal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    const reason = error instanceof Error ? error.message : String(error);
    input.context.emitDiagnostic?.({
      level: "warn",
      message: "llama-server prompt token preflight request failed.",
      data: {
        runId: input.context.runId,
        caseId: input.caseConfig.caseId,
        reason: redactSecret(reason, input.runState.apiKey),
      },
    });

    throw createCodeError(
      "ENGINE_EXECUTION_FAILED",
      "llama-server prompt token preflight request failed.",
    );
  }

  let responseBody: {
    text: string;
    byteLength: number;
  };
  try {
    responseBody = await readResponseBodyWithLimit(
      response,
      input.dependencies.maxCaseResponseBytes,
    );
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    if (error instanceof ResponseBodyTooLargeError) {
      input.context.emitDiagnostic?.({
        level: "warn",
        message: "llama-server prompt token preflight response exceeded configured size limit.",
        data: {
          runId: input.context.runId,
          caseId: input.caseConfig.caseId,
          maxCaseResponseBytes: input.dependencies.maxCaseResponseBytes,
          observedResponseBytes: error.observedBytes,
        },
      });

      throw createCodeError(
        "ENGINE_EXECUTION_FAILED",
        `llama-server prompt token preflight response exceeded ${input.dependencies.maxCaseResponseBytes} bytes.`,
      );
    }

    const reason = error instanceof Error ? error.message : String(error);
    throw createCodeError(
      "ENGINE_EXECUTION_FAILED",
      `Failed to read llama-server prompt token preflight response: ${reason}`,
    );
  }

  if (!response.ok) {
    input.context.emitDiagnostic?.({
      level: "warn",
      message: "llama-server prompt token preflight returned non-success response.",
      data: {
        runId: input.context.runId,
        caseId: input.caseConfig.caseId,
        status: response.status,
        responseBodyBytes: responseBody.byteLength,
      },
    });

    throw createCodeError(
      "ENGINE_EXECUTION_FAILED",
      `llama-server prompt token preflight failed with HTTP ${response.status}.`,
    );
  }

  let parsedResponse: unknown;
  try {
    parsedResponse = JSON.parse(responseBody.text);
  } catch {
    throw createCodeError(
      "ENGINE_EXECUTION_FAILED",
      "llama-server prompt token preflight returned invalid JSON.",
    );
  }

  const promptTokenCount = parseTokenizeResponseTokenCount(parsedResponse);
  if (promptTokenCount === null) {
    throw createCodeError(
      "ENGINE_EXECUTION_FAILED",
      "llama-server prompt token preflight response did not include a valid token list.",
    );
  }

  return promptTokenCount;
}

function parseTokenizeResponseTokenCount(response: unknown): number | null {
  if (!isRecord(response)) {
    return null;
  }

  const tokens = response.tokens;
  if (!Array.isArray(tokens)) {
    return null;
  }

  for (const token of tokens) {
    if (typeof token !== "number" || !Number.isFinite(token)) {
      return null;
    }
  }

  return tokens.length;
}
