import type {
  EngineCaseConfig,
  EngineCaseResult,
  EngineEnvironmentSummary,
  EngineLaunchConfig,
  EngineRunConfigValidationResult,
  EngineValidationIssue,
  EngineValidationMode,
  EnginePlugin,
  EngineRunConfig,
  EngineRuntimeContext,
} from "./engine-plugin.ts";
import { ENGINE_PLUGIN_API_VERSION } from "./engine-plugin.ts";

export const STARTER_ENGINE_ID = "llama-cpp";

const RESERVED_SERVER_FLAGS = new Set([
  "-m",
  "--model",
  "--host",
  "--port",
  "--api-key",
  "--api_key",
  "--webui",
  "--no-webui",
]);

const DENYLISTED_SERVER_FLAGS = new Set([
  "--path-prompt-cache",
  "--prompt-cache",
  "--logdir",
]);

const STRICT_SERVER_FLAG_BASELINE = new Set([
  "--alias",
  "--batch-size",
  "--cache-type-k",
  "--cache-type-v",
  "--chat-template",
  "--ctx-size",
  "--defrag-thold",
  "--flash-attn",
  "--gpu-layers",
  "--grp-attn-n",
  "--grp-attn-w",
  "--jinja",
  "--log-disable",
  "--main-gpu",
  "--metrics",
  "--mlock",
  "--n-gpu-layers",
  "--n-predict",
  "--n-probs",
  "--no-mmap",
  "--no-context-shift",
  "--override-kv",
  "--poll",
  "--repeat-last-n",
  "--repeat-penalty",
  "--rope-freq-base",
  "--rope-freq-scale",
  "--seed",
  "--split-mode",
  "--temp",
  "--threads",
  "--threads-batch",
  "--top-k",
  "--top-p",
  "--typical",
  "--ubatch-size",
]);

const RESERVED_REQUEST_PARAM_KEYS = new Set([
  "messages",
  "model",
  "stream",
]);

const STRICT_REQUEST_PARAM_BASELINE = new Set([
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "max_tokens",
  "n",
  "presence_penalty",
  "response_format",
  "seed",
  "stop",
  "temperature",
  "top_logprobs",
  "top_p",
  "user",
]);

export const starterLlamaCppPlugin: EnginePlugin = {
  apiVersion: ENGINE_PLUGIN_API_VERSION,
  id: STARTER_ENGINE_ID,
  displayName: "llama.cpp",
  version: "unknown",
  capabilities: {
    chatCompletions: true,
    localTarget: true,
    streaming: true,
  },
  async validateEnvironment(): Promise<EngineEnvironmentSummary> {
    return {
      status: "unknown",
      message: "Environment validation is not wired yet.",
    };
  },
  async validateRunConfig(
    runConfig: EngineRunConfig,
  ): Promise<EngineRunConfigValidationResult> {
    const issues: EngineValidationIssue[] = [];

    validateServerArgs(runConfig.engine.serverArgs, runConfig.validationMode, issues);
    validateRequestParams(
      runConfig.engine.requestParams,
      runConfig.validationMode,
      issues,
    );

    if (issues.length > 0) {
      return {
        ok: false,
        code: "VALIDATION_ENGINE_OPTIONS_INVALID",
        message:
          "Engine options are invalid for llama.cpp. Remove reserved or unsupported values and retry.",
        issues,
      };
    }

    return {
      ok: true,
      normalized: {
        serverArgs: [...runConfig.engine.serverArgs],
        requestParams: { ...runConfig.engine.requestParams },
      },
    };
  },
  async buildLaunchConfig(runConfig: EngineRunConfig): Promise<EngineLaunchConfig> {
    const issues: EngineValidationIssue[] = [];
    validateServerArgs(runConfig.engine.serverArgs, runConfig.validationMode, issues);

    if (issues.length > 0) {
      throw new Error("llama.cpp launch config rejected invalid server args.");
    }

    return {
      command: "llama-server",
      args: [...runConfig.engine.serverArgs],
    };
  },
  async start(_context: EngineRuntimeContext): Promise<void> {
    return;
  },
  async waitUntilReady(_context: EngineRuntimeContext): Promise<void> {
    return;
  },
  async executeCase(
    _context: EngineRuntimeContext,
    caseConfig: EngineCaseConfig,
  ): Promise<EngineCaseResult> {
    return {
      outputText: "",
      rawResponse: {
        caseId: caseConfig.caseId,
        status: "not-implemented",
      },
    };
  },
  async collectMetrics(_context: EngineRuntimeContext): Promise<Record<string, unknown>> {
    return {};
  },
  async stop(_context: EngineRuntimeContext): Promise<void> {
    return;
  },
};

function validateServerArgs(
  serverArgs: string[],
  validationMode: EngineValidationMode,
  issues: EngineValidationIssue[],
): void {
  for (const [index, argument] of serverArgs.entries()) {
    const path = `engine.serverArgs[${index}]`;

    if (!argument.startsWith("-")) {
      issues.push({
        code: "SERVER_ARG_POSITIONAL_NOT_ALLOWED",
        message: `Argument '${argument}' is positional; expected a --flag style argument.`,
        path,
      });
      continue;
    }

    const flag = extractFlagToken(argument);

    if (RESERVED_SERVER_FLAGS.has(flag)) {
      issues.push({
        code: "SERVER_ARG_RESERVED",
        message: `Argument '${flag}' is reserved and owned by the orchestrator.`,
        path,
      });
      continue;
    }

    if (DENYLISTED_SERVER_FLAGS.has(flag)) {
      issues.push({
        code: "SERVER_ARG_DENYLISTED",
        message: `Argument '${flag}' is denied by the current safety policy.`,
        path,
      });
      continue;
    }

    if (validationMode === "strict" && !STRICT_SERVER_FLAG_BASELINE.has(flag)) {
      issues.push({
        code: "SERVER_ARG_UNKNOWN",
        message:
          `Argument '${flag}' is not in the strict llama.cpp baseline. ` +
          "Use validationMode=permissive to experiment with additional flags.",
        path,
      });
    }
  }
}

function validateRequestParams(
  requestParams: Record<string, unknown>,
  validationMode: EngineValidationMode,
  issues: EngineValidationIssue[],
): void {
  for (const [key, value] of Object.entries(requestParams)) {
    if (RESERVED_REQUEST_PARAM_KEYS.has(key)) {
      issues.push({
        code: "REQUEST_PARAM_RESERVED",
        message: `requestParams.${key} is reserved and owned by the orchestrator.`,
        path: `engine.requestParams.${key}`,
      });
      continue;
    }

    if (validationMode === "strict" && !STRICT_REQUEST_PARAM_BASELINE.has(key)) {
      issues.push({
        code: "REQUEST_PARAM_UNKNOWN",
        message:
          `requestParams.${key} is not in the strict llama.cpp baseline. ` +
          "Use validationMode=permissive to experiment with additional keys.",
        path: `engine.requestParams.${key}`,
      });
      continue;
    }

    if (!isRequestParamValueValid(value)) {
      issues.push({
        code: "REQUEST_PARAM_INVALID_TYPE",
        message: `requestParams.${key} has an unsupported value type.`,
        path: `engine.requestParams.${key}`,
      });
    }
  }
}

function extractFlagToken(argument: string): string {
  const equalsIndex = argument.indexOf("=");
  if (equalsIndex === -1) {
    return argument;
  }

  return argument.slice(0, equalsIndex);
}

function isRequestParamValueValid(value: unknown): boolean {
  if (value === null) {
    return true;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isRequestParamValueValid(entry));
  }

  if (typeof value === "object") {
    return Object.values(value).every((entry) => isRequestParamValueValid(entry));
  }

  return false;
}
