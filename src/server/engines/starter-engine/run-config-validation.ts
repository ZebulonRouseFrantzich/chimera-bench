/**
 * Validation routines for starter-engine serverArgs and requestParams.
 *
 * Strict mode validates flag compatibility against discovered llama-server help
 * output, while permissive mode enforces only safety constraints.
 */
import type {
  EngineRunConfig,
  EngineValidationIssue,
  EngineValidationMode,
} from "../engine-plugin.ts";
import type { TargetProfile } from "../../targets/target-profile.ts";
import {
  DENYLISTED_SERVER_FLAGS,
  RESERVED_REQUEST_PARAM_KEYS,
  RESERVED_SERVER_FLAGS,
  STRICT_REQUEST_PARAM_BASELINE,
} from "./constants.ts";
import type {
  ServerArgsValidationResult,
  StarterLlamaCppPluginDependencies,
} from "./types.ts";
import { normalizeIssueMessage, toError } from "./utils.ts";

export async function validateServerArgs(
  serverArgs: string[],
  validationMode: EngineValidationMode,
  dependencies: StarterLlamaCppPluginDependencies,
  target: EngineRunConfig["target"],
  sshProfile: TargetProfile | null,
): Promise<ServerArgsValidationResult> {
  const issues: EngineValidationIssue[] = [];
  const strictCandidateFlags: Array<{
    flag: string;
    rawFlag: string;
    path: string;
  }> = [];

  for (let index = 0; index < serverArgs.length; index += 1) {
    const argument = serverArgs[index];
    if (!argument) {
      continue;
    }

    const path = `engine.serverArgs[${index}]`;
    if (!argument.startsWith("-")) {
      issues.push({
        code: "SERVER_ARG_POSITIONAL_NOT_ALLOWED",
        message: `Argument '${argument}' is positional; expected a --flag style argument.`,
        path,
      });
      continue;
    }

    const rawFlag = extractFlagToken(argument);
    const normalizedFlag = rawFlag.toLowerCase();

    if (RESERVED_SERVER_FLAGS.has(normalizedFlag)) {
      issues.push({
        code: "SERVER_ARG_RESERVED",
        message: `Argument '${rawFlag}' is reserved and owned by the orchestrator.`,
        path,
      });
    } else if (DENYLISTED_SERVER_FLAGS.has(normalizedFlag)) {
      issues.push({
        code: "SERVER_ARG_DENYLISTED",
        message: `Argument '${rawFlag}' is denied by the current safety policy.`,
        path,
      });
    } else if (validationMode === "strict") {
      strictCandidateFlags.push({
        flag: normalizedFlag,
        rawFlag,
        path,
      });
    }

    const nextArgument = serverArgs[index + 1];
    if (
      !argument.includes("=") &&
      typeof nextArgument === "string" &&
      nextArgument.length > 0 &&
      isServerArgValueToken(nextArgument)
    ) {
      index += 1;
    }
  }

  if (validationMode !== "strict" || strictCandidateFlags.length === 0) {
    return {
      issues,
      strictFlagDiscoveryFailed: false,
    };
  }

  let supportedFlags: ReadonlySet<string>;
  try {
    if (target.type === "ssh") {
      if (!sshProfile) {
        throw new Error("Remote strict validation requires a resolvable SSH target profile.");
      }

      supportedFlags = await dependencies.discoverRemoteSupportedServerFlags(sshProfile);
    } else {
      supportedFlags = await dependencies.discoverSupportedServerFlags();
    }
  } catch (error) {
    const reason = normalizeIssueMessage(toError(error).message);
    issues.push({
      code: "SERVER_ARG_FLAG_DISCOVERY_FAILED",
      message:
        (target.type === "ssh"
          ? "Unable to parse supported flags from remote `llama-server --help` in strict mode. "
          : "Unable to parse supported flags from `llama-server --help` in strict mode. ") +
        `Retry with validationMode=permissive or fix llama-server installation. (${reason})`,
      path: "engine.serverArgs",
    });

    return {
      issues,
      strictFlagDiscoveryFailed: true,
    };
  }

  for (const candidate of strictCandidateFlags) {
    if (supportedFlags.has(candidate.flag)) {
      continue;
    }

    issues.push({
      code: "SERVER_ARG_UNKNOWN",
      message:
        `Argument '${candidate.rawFlag}' is not reported by this llama-server build. ` +
        "Use validationMode=permissive to experiment with unknown flags.",
      path: candidate.path,
    });
  }

  return {
    issues,
    strictFlagDiscoveryFailed: false,
  };
}

export function validateRequestParams(
  requestParams: Record<string, unknown>,
  validationMode: EngineValidationMode,
  issues: EngineValidationIssue[],
): void {
  for (const [key, value] of Object.entries(requestParams)) {
    const path = `engine.requestParams.${key}`;

    if (RESERVED_REQUEST_PARAM_KEYS.has(key)) {
      issues.push({
        code: "REQUEST_PARAM_RESERVED",
        message: `requestParams.${key} is reserved and owned by the orchestrator.`,
        path,
      });
      continue;
    }

    if (validationMode === "strict" && !STRICT_REQUEST_PARAM_BASELINE.has(key)) {
      issues.push({
        code: "REQUEST_PARAM_UNKNOWN",
        message:
          `requestParams.${key} is not in the strict llama.cpp baseline. ` +
          "Use validationMode=permissive to experiment with additional keys.",
        path,
      });
      continue;
    }

    switch (key) {
      case "temperature":
        validateNumberRange(value, path, issues, {
          code: "REQUEST_PARAM_INVALID_RANGE",
          min: 0,
          max: 2,
          label: "temperature",
        });
        break;
      case "top_p":
        validateNumberRange(value, path, issues, {
          code: "REQUEST_PARAM_INVALID_RANGE",
          min: 0,
          max: 1,
          label: "top_p",
        });
        break;
      case "frequency_penalty":
      case "presence_penalty":
        validateNumberRange(value, path, issues, {
          code: "REQUEST_PARAM_INVALID_RANGE",
          min: -2,
          max: 2,
          label: key,
        });
        break;
      case "max_tokens":
      case "n":
      case "seed":
      case "top_logprobs":
        validateInteger(value, path, issues, {
          code: "REQUEST_PARAM_INVALID_TYPE",
          label: key,
          ...(key === "seed"
            ? {}
            : {
                min: 1,
              }),
          ...(key === "top_logprobs"
            ? {
                max: 20,
              }
            : {}),
        });
        break;
      case "logprobs":
        if (typeof value !== "boolean") {
          issues.push({
            code: "REQUEST_PARAM_INVALID_TYPE",
            message: "requestParams.logprobs must be a boolean.",
            path,
          });
        }
        break;
      case "stop":
        if (typeof value === "string") {
          break;
        }

        if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
          break;
        }

        issues.push({
          code: "REQUEST_PARAM_INVALID_TYPE",
          message: "requestParams.stop must be a string or an array of strings.",
          path,
        });
        break;
      case "user":
        if (typeof value !== "string") {
          issues.push({
            code: "REQUEST_PARAM_INVALID_TYPE",
            message: "requestParams.user must be a string.",
            path,
          });
        }
        break;
      case "response_format":
        if (!isPlainObject(value)) {
          issues.push({
            code: "REQUEST_PARAM_INVALID_TYPE",
            message: "requestParams.response_format must be an object.",
            path,
          });
        }
        break;
      case "logit_bias":
        if (!isPlainObject(value)) {
          issues.push({
            code: "REQUEST_PARAM_INVALID_TYPE",
            message: "requestParams.logit_bias must be an object of numeric bias values.",
            path,
          });
          break;
        }

        for (const [nestedKey, nestedValue] of Object.entries(value)) {
          if (!Number.isFinite(Number.parseInt(nestedKey, 10))) {
            issues.push({
              code: "REQUEST_PARAM_INVALID_TYPE",
              message: "requestParams.logit_bias keys must be token id strings.",
              path: `${path}.${nestedKey}`,
            });
            continue;
          }

          if (typeof nestedValue !== "number" || !Number.isFinite(nestedValue)) {
            issues.push({
              code: "REQUEST_PARAM_INVALID_TYPE",
              message: "requestParams.logit_bias values must be finite numbers.",
              path: `${path}.${nestedKey}`,
            });
          }
        }
        break;
      default:
        if (!isRequestParamValueValid(value)) {
          issues.push({
            code: "REQUEST_PARAM_INVALID_TYPE",
            message: `requestParams.${key} has an unsupported value type.`,
            path,
          });
        }
    }
  }
}

function validateNumberRange(
  value: unknown,
  path: string,
  issues: EngineValidationIssue[],
  options: {
    code: string;
    min: number;
    max: number;
    label: string;
  },
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({
      code: "REQUEST_PARAM_INVALID_TYPE",
      message: `requestParams.${options.label} must be a finite number.`,
      path,
    });
    return;
  }

  if (value < options.min || value > options.max) {
    issues.push({
      code: options.code,
      message: `requestParams.${options.label} must be between ${options.min} and ${options.max}.`,
      path,
    });
  }
}

function validateInteger(
  value: unknown,
  path: string,
  issues: EngineValidationIssue[],
  options: {
    code: string;
    label: string;
    min?: number;
    max?: number;
  },
): void {
  if (!Number.isInteger(value)) {
    issues.push({
      code: options.code,
      message: `requestParams.${options.label} must be an integer.`,
      path,
    });
    return;
  }

  const intValue = value as number;

  if (typeof options.min === "number" && intValue < options.min) {
    issues.push({
      code: "REQUEST_PARAM_INVALID_RANGE",
      message: `requestParams.${options.label} must be >= ${options.min}.`,
      path,
    });
  }

  if (typeof options.max === "number" && intValue > options.max) {
    issues.push({
      code: "REQUEST_PARAM_INVALID_RANGE",
      message: `requestParams.${options.label} must be <= ${options.max}.`,
      path,
    });
  }
}

function extractFlagToken(argument: string): string {
  const equalsIndex = argument.indexOf("=");
  if (equalsIndex === -1) {
    return argument;
  }

  return argument.slice(0, equalsIndex);
}

function isServerArgValueToken(token: string): boolean {
  if (!token.startsWith("-")) {
    return true;
  }

  return /^-(?:\d|\.\d)/.test(token);
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
