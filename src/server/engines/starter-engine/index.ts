/**
 * Built-in llama.cpp engine plugin implementation for local and SSH targets.
 *
 * This entrypoint composes launch validation, startup/readiness probing, case
 * execution scaffolding, diagnostics redaction, and shutdown behavior.
 */
import type {
  EngineCaseConfig,
  EngineCaseResult,
  EngineEnvironmentSummary,
  EngineLaunchConfig,
  EnginePlugin,
  EngineRunConfig,
  EngineRunConfigValidationResult,
  EngineValidationIssue,
  EngineRuntimeContext,
} from "../engine-plugin.ts";
import { ENGINE_PLUGIN_API_VERSION } from "../engine-plugin.ts";
import {
  createStarterSshLaunchMetadata,
  serializeStarterSshLaunchMetadata,
} from "../starter-engine-ssh.ts";
import { validateSshModelIdentifier } from "../../runs/ssh-model-identifier-validation.ts";
import type { TargetProfile } from "../../targets/target-profile.ts";
import {
  LLAMA_SERVER_COMMAND,
  LOOPBACK_HOST,
  STARTER_ENGINE_ID,
} from "./constants.ts";
import { createDependencies } from "./dependencies.ts";
import { validateModelIdentifier } from "./model-validation.ts";
import {
  buildEngineStartFailedError,
  waitForReadinessProbe,
} from "./readiness.ts";
import { activateRunState, stopRunState } from "./run-state.ts";
import {
  validateRequestParams,
  validateServerArgs,
} from "./run-config-validation.ts";
import { spawnLlamaServerAttempt } from "./spawn.ts";
import {
  assertApiKeyStrength,
  buildStartupFailureError,
  isRetryableStartupFailure,
  parseSshLaunchMetadata,
  startSshLlamaServerWithRetries,
} from "./startup.ts";
import type {
  LlamaServerRunState,
  LlamaServerStartupFailure,
  StarterLlamaCppPluginDependencies,
} from "./types.ts";
import {
  buildHealthRequestHeaders,
  buildHealthUrl,
  extractRequiredFlagValue,
  parseFlagIntValue,
  redactSecret,
  replaceRequiredFlagValue,
} from "./utils.ts";

export type { StarterLlamaCppPluginDependencies } from "./types.ts";

export const starterLlamaCppPlugin = createStarterLlamaCppPlugin();

export function createStarterLlamaCppPlugin(
  overrides: Partial<StarterLlamaCppPluginDependencies> = {},
): EnginePlugin {
  const dependencies = createDependencies(overrides);
  const runStates = new Map<string, LlamaServerRunState>();

  return {
    apiVersion: ENGINE_PLUGIN_API_VERSION,
    id: STARTER_ENGINE_ID,
    displayName: "llama.cpp",
    version: "unknown",
    capabilities: {
      chatCompletions: true,
      localTarget: true,
      sshTarget: true,
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
      let normalizedModelIdentifier = runConfig.model.identifier;

      let sshProfile: TargetProfile | null = null;

      if (runConfig.target.type === "local") {
        const modelIdentifierValidation = await validateModelIdentifier(
          runConfig.model.identifier,
          dependencies.modelRoots,
        );
        if (modelIdentifierValidation.ok) {
          normalizedModelIdentifier = modelIdentifierValidation.normalizedIdentifier;
        } else {
          issues.push(...modelIdentifierValidation.issues);
        }
      } else if (runConfig.target.type === "ssh") {
        try {
          sshProfile = await dependencies.getTargetProfile(runConfig.target.profileId);
        } catch {
          issues.push({
            code: "TARGET_PROFILE_NOT_FOUND",
            message: "target.profileId must reference an existing target profile.",
            path: "target.profileId",
          });
        }

        if (sshProfile) {
          const modelIdentifierValidation = validateSshModelIdentifier(
            runConfig.model.identifier,
            sshProfile.remoteModelRoots,
          );
          if (modelIdentifierValidation.ok) {
            normalizedModelIdentifier = modelIdentifierValidation.normalizedIdentifier;
          } else {
            issues.push(...modelIdentifierValidation.issues);
          }
        }
      }

      const serverArgsValidation = await validateServerArgs(
        runConfig.engine.serverArgs,
        runConfig.validationMode,
        dependencies,
        runConfig.target,
        sshProfile,
      );
      issues.push(...serverArgsValidation.issues);

      validateRequestParams(
        runConfig.engine.requestParams,
        runConfig.validationMode,
        issues,
      );

      if (serverArgsValidation.strictFlagDiscoveryFailed) {
        return {
          ok: false,
          code: "VALIDATION_ENGINE_OPTIONS_INVALID",
          message:
            "Strict server-argument validation requires parsing `llama-server --help`, but flag discovery failed. Fix the llama-server installation or retry with validationMode=permissive.",
          issues,
        };
      }

      if (issues.length > 0) {
        const hasModelIdentifierIssue = issues.some((issue) =>
          issue.code.startsWith("MODEL_IDENTIFIER_"),
        );
        const hasModelRootIssue = issues.some((issue) => issue.code.startsWith("MODEL_ROOT_"));

        let code = "VALIDATION_ENGINE_OPTIONS_INVALID";
        let message =
          "Engine options are invalid for llama.cpp. Remove reserved or unsupported values and retry.";

        if (hasModelIdentifierIssue) {
          code = "VALIDATION_MODEL_IDENTIFIER_INVALID";
          message =
            "model.identifier must reference a readable local .gguf file within configured model roots.";
        } else if (hasModelRootIssue) {
          code = "VALIDATION_MODEL_ROOTS_INVALID";
          message =
            "Server model root configuration is invalid. Check CHIMERA_MODEL_ROOTS and retry.";
        }

        return {
          ok: false,
          code,
          message,
          issues,
        };
      }

      return {
        ok: true,
        normalized: {
          modelIdentifier: normalizedModelIdentifier,
          serverArgs: [...runConfig.engine.serverArgs],
          requestParams: { ...runConfig.engine.requestParams },
        },
      };
    },
    async buildLaunchConfig(runConfig: EngineRunConfig): Promise<EngineLaunchConfig> {
      const serverArgsValidation = await validateServerArgs(
        runConfig.engine.serverArgs,
        "permissive",
        dependencies,
        runConfig.target,
        null,
      );
      if (serverArgsValidation.issues.length > 0) {
        throw new Error("llama.cpp launch config rejected invalid server args.");
      }

      if (runConfig.target.type === "ssh") {
        const profile = await dependencies.getTargetProfile(runConfig.target.profileId);
        const launchMetadata = createStarterSshLaunchMetadata({
          profile,
          modelIdentifier: runConfig.model.identifier,
          serverArgs: runConfig.engine.serverArgs,
        });

        return {
          command: "ssh",
          args: [],
          metadata: serializeStarterSshLaunchMetadata(launchMetadata),
        };
      }

      const modelIdentifierValidation = await validateModelIdentifier(
        runConfig.model.identifier,
        dependencies.modelRoots,
      );
      if (!modelIdentifierValidation.ok) {
        throw new Error(
          "llama.cpp launch config rejected model.identifier; expected a readable local .gguf file.",
        );
      }

      const port = await dependencies.allocateLoopbackPort();
      const apiKey = dependencies.createApiKey();
      assertApiKeyStrength(apiKey);

      return {
        command: LLAMA_SERVER_COMMAND,
        args: [
          "--model",
          modelIdentifierValidation.normalizedIdentifier,
          "--host",
          LOOPBACK_HOST,
          "--port",
          String(port),
          "--api-key",
          apiKey,
          "--no-webui",
          ...runConfig.engine.serverArgs,
        ],
      };
    },
    async start(context: EngineRuntimeContext): Promise<void> {
      if (context.abortSignal.aborted) {
        throw new Error(`Run '${context.runId}' was aborted before engine start.`);
      }

      const existingRunState = runStates.get(context.runId);
      if (existingRunState) {
        runStates.delete(context.runId);
        await stopRunState(existingRunState, {
          runId: context.runId,
          reason: "restart",
          emitDiagnostic: context.emitDiagnostic,
          dependencies,
        });
      }

      const sshLaunchMetadata = parseSshLaunchMetadata(context.launchConfig.metadata);
      if (sshLaunchMetadata) {
        const runState = await startSshLlamaServerWithRetries({
          runId: context.runId,
          launchMetadata: sshLaunchMetadata,
          emitDiagnostic: context.emitDiagnostic,
          dependencies,
        });

        activateRunState({
          context,
          runState,
          runStates,
          dependencies,
        });
        return;
      }

      const apiKey = extractRequiredFlagValue(context.launchConfig.args, "--api-key");
      assertApiKeyStrength(apiKey);
      let launchArgs = [...context.launchConfig.args];
      let lastFailure: LlamaServerStartupFailure | null = null;

      for (let attempt = 1; attempt <= dependencies.startupRetryAttempts; attempt += 1) {
        const attemptResult = await spawnLlamaServerAttempt({
          command: context.launchConfig.command,
          args: launchArgs,
          ...(context.launchConfig.environmentOverrides
            ? {
                environmentOverrides: context.launchConfig.environmentOverrides,
              }
            : {}),
          runId: context.runId,
          apiKey,
          dependencies,
        });

        if (attemptResult.ok) {
          const runState: LlamaServerRunState = {
            mode: "local",
            ...attemptResult.state,
            healthUrl: buildHealthUrl(launchArgs),
            healthRequestHeaders: buildHealthRequestHeaders(apiKey),
            apiKey,
            startupDiagnosticData: {
              ...(parseFlagIntValue(launchArgs, "--port") !== null
                ? {
                    port: parseFlagIntValue(launchArgs, "--port"),
                  }
                : {}),
            },
            removeAbortListener: () => {
              return;
            },
          };

          activateRunState({
            context,
            runState,
            runStates,
            dependencies,
          });

          return;
        }

        lastFailure = attemptResult.failure;
        const shouldRetryWithNewPort =
          attempt < dependencies.startupRetryAttempts &&
          isRetryableStartupFailure(lastFailure);

        if (!shouldRetryWithNewPort) {
          break;
        }

        const retryPort = await dependencies.allocateLoopbackPort();
        launchArgs = replaceRequiredFlagValue(launchArgs, "--port", String(retryPort));

        context.emitDiagnostic?.({
          level: "warn",
          message:
            "llama-server failed to bind or exited during startup; retrying with a new loopback port.",
          data: {
            runId: context.runId,
            attempt,
            reason: redactSecret(lastFailure.reason, apiKey),
          },
        });
      }

      if (!lastFailure) {
        throw new Error("llama-server startup failed before a process could be launched.");
      }

      throw buildStartupFailureError({
        runId: context.runId,
        command: context.launchConfig.command,
        args: launchArgs,
        failure: lastFailure,
        apiKey,
      });
    },
    async waitUntilReady(context: EngineRuntimeContext): Promise<void> {
      const runState = runStates.get(context.runId);
      if (!runState) {
        throw new Error(
          `llama-server runtime is not active for run '${context.runId}'. Call start() first.`,
        );
      }

      try {
        await waitForReadinessProbe(runState, context.abortSignal, dependencies);
      } catch (error) {
        const readinessError = error instanceof Error ? error : new Error(String(error));
        context.emitDiagnostic?.({
          level: "warn",
          message: "llama-server readiness probe failed.",
          data: {
            runId: context.runId,
            healthUrl: runState.healthUrl,
            reason: redactSecret(readinessError.message, runState.apiKey),
          },
        });
        const startupFailure = buildEngineStartFailedError({
          runId: context.runId,
          reason: readinessError.message,
          runState,
          dependencies,
        });
        const activeRunState = runStates.get(context.runId);
        if (activeRunState === runState) {
          runStates.delete(context.runId);
        }

        await stopRunState(runState, {
          runId: context.runId,
          reason: "readiness-failed",
          emitDiagnostic: context.emitDiagnostic,
          dependencies,
        });

        throw startupFailure;
      }

      context.emitDiagnostic?.({
        level: "info",
        message: "llama-server readiness probe succeeded.",
        data: {
          runId: context.runId,
        },
      });
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
    async stop(context: EngineRuntimeContext): Promise<void> {
      const runState = runStates.get(context.runId);
      if (!runState) {
        return;
      }

      runStates.delete(context.runId);
      await stopRunState(runState, {
        runId: context.runId,
        reason: "stop",
        emitDiagnostic: context.emitDiagnostic,
        dependencies,
      });
    },
  };
}
