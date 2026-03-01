import { spawn } from "node:child_process";
import type {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, relative, resolve } from "node:path";
import type { Readable } from "node:stream";
import type {
  EngineCaseConfig,
  EngineCaseResult,
  EngineEnvironmentSummary,
  EngineStartFailedError,
  EngineLaunchConfig,
  EngineRunConfigValidationResult,
  EngineValidationIssue,
  EngineValidationMode,
  EnginePlugin,
  EngineRunConfig,
  EngineRuntimeContext,
} from "./engine-plugin.ts";
import {
  ENGINE_PLUGIN_API_VERSION,
  EngineStartFailedError as EngineStartFailedErrorClass,
  hasRestrictedEnvironmentOverrides,
} from "./engine-plugin.ts";

export const STARTER_ENGINE_ID = "llama-cpp";

const LOOPBACK_HOST = "127.0.0.1";
const LLAMA_SERVER_COMMAND = "llama-server";
const REDACTED_VALUE = "[REDACTED]";
const API_KEY_ENTROPY_BYTES = 32;
const MIN_API_KEY_LENGTH = 43;
const DEFAULT_STARTUP_PROBE_WINDOW_MS = 300;
const DEFAULT_STARTUP_RETRY_ATTEMPTS = 4;
const DEFAULT_STOP_GRACE_PERIOD_MS = 2_000;
const DEFAULT_KILL_WAIT_TIMEOUT_MS = 1_000;
const DEFAULT_BUFFERED_LOG_CHARS = 64 * 1024;
const DEFAULT_DIAGNOSTIC_EXCERPT_CHARS = 4 * 1024;
const DEFAULT_READINESS_POLL_INTERVAL_MS = 200;
const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
const DEFAULT_READINESS_REQUEST_TIMEOUT_MS = 1_000;
const DEFAULT_SERVER_HELP_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_HELP_OUTPUT_CHARS = 128 * 1024;
const READINESS_ERROR_EXCERPT_CHARS = 256;

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
  "--prompt-cache-all",
  "--logdir",
  "--public",
]);

const RESERVED_REQUEST_PARAM_KEYS = new Set(["messages", "model", "stream"]);

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

interface ProcessTerminationExit {
  kind: "exit";
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ProcessTerminationError {
  kind: "error";
  error: Error;
}

type ProcessTermination = ProcessTerminationExit | ProcessTerminationError;

interface LlamaServerRunState {
  process: ChildProcessWithoutNullStreams;
  terminationPromise: Promise<ProcessTermination>;
  stdoutBuffer: RollingTextBuffer;
  stderrBuffer: RollingTextBuffer;
  healthUrl: string;
  healthRequestHeaders: Record<string, string>;
  apiKey: string;
  removeAbortListener: () => void;
}

interface LlamaServerStartupFailure {
  reason: string;
  stdoutExcerpt: string;
  stderrExcerpt: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

interface SpawnAttemptSuccess {
  ok: true;
  state: Pick<
    LlamaServerRunState,
    "process" | "terminationPromise" | "stdoutBuffer" | "stderrBuffer"
  >;
}

interface SpawnAttemptFailure {
  ok: false;
  failure: LlamaServerStartupFailure;
}

type SpawnAttemptResult = SpawnAttemptSuccess | SpawnAttemptFailure;

interface StopRunStateInput {
  runId: string;
  reason: string;
  emitDiagnostic: EngineRuntimeContext["emitDiagnostic"];
  dependencies: StarterLlamaCppPluginDependencies;
}

interface SpawnAttemptInput {
  command: string;
  args: string[];
  environmentOverrides?: Record<string, string>;
  runId: string;
  apiKey: string;
  dependencies: StarterLlamaCppPluginDependencies;
}

export interface StarterLlamaCppPluginDependencies {
  spawnProcess: (
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  allocateLoopbackPort: () => Promise<number>;
  createApiKey: () => string;
  modelRoots: readonly string[];
  signalProcessGroup: (pid: number, signal: NodeJS.Signals) => void;
  discoverSupportedServerFlags: () => Promise<ReadonlySet<string>>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  wait: (ms: number) => Promise<void>;
  now: () => number;
  startupProbeWindowMs: number;
  startupRetryAttempts: number;
  stopGracePeriodMs: number;
  killWaitTimeoutMs: number;
  readinessPollIntervalMs: number;
  readinessTimeoutMs: number;
  readinessRequestTimeoutMs: number;
  bufferedLogChars: number;
  diagnosticExcerptChars: number;
}

interface ReadinessProbeSuccess {
  kind: "ready";
}

interface ReadinessProbeRetry {
  kind: "retry";
}

interface ReadinessProbeFailure {
  kind: "failed";
  reason: string;
}

type ReadinessProbeResult =
  | ReadinessProbeSuccess
  | ReadinessProbeRetry
  | ReadinessProbeFailure;

interface ServerArgsValidationResult {
  issues: EngineValidationIssue[];
  strictFlagDiscoveryFailed: boolean;
}

interface ModelIdentifierValidationSuccess {
  ok: true;
  normalizedIdentifier: string;
}

interface ModelIdentifierValidationFailure {
  ok: false;
  issues: EngineValidationIssue[];
}

type ModelIdentifierValidationResult =
  | ModelIdentifierValidationSuccess
  | ModelIdentifierValidationFailure;

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

      const modelIdentifierValidation = await validateModelIdentifier(
        runConfig.model.identifier,
        dependencies.modelRoots,
      );
      if (modelIdentifierValidation.ok) {
        normalizedModelIdentifier = modelIdentifierValidation.normalizedIdentifier;
      } else {
        issues.push(...modelIdentifierValidation.issues);
      }

      const serverArgsValidation = await validateServerArgs(
        runConfig.engine.serverArgs,
        runConfig.validationMode,
        dependencies,
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
      const modelIdentifierValidation = await validateModelIdentifier(
        runConfig.model.identifier,
        dependencies.modelRoots,
      );
      if (!modelIdentifierValidation.ok) {
        throw new Error(
          "llama.cpp launch config rejected model.identifier; expected a readable local .gguf file.",
        );
      }

      const serverArgsValidation = await validateServerArgs(
        runConfig.engine.serverArgs,
        "permissive",
        dependencies,
      );
      if (serverArgsValidation.issues.length > 0) {
        throw new Error("llama.cpp launch config rejected invalid server args.");
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
          let abortListenerRemoved = false;
          const removeAbortListener = () => {
            if (abortListenerRemoved) {
              return;
            }

            abortListenerRemoved = true;
            context.abortSignal.removeEventListener("abort", abortListener);
          };

          const runState: LlamaServerRunState = {
            ...attemptResult.state,
            healthUrl: buildHealthUrl(launchArgs),
            healthRequestHeaders: buildHealthRequestHeaders(apiKey),
            apiKey,
            removeAbortListener,
          };

          const abortListener = () => {
            const activeRunState = runStates.get(context.runId);
            if (activeRunState !== runState) {
              return;
            }

            runStates.delete(context.runId);
            void stopRunState(runState, {
              runId: context.runId,
              reason: "abort-signal",
              emitDiagnostic: context.emitDiagnostic,
              dependencies,
            }).catch(() => {
              context.emitDiagnostic?.({
                level: "warn",
                message:
                  "llama.cpp process cleanup failed after abort signal; check server logs for details.",
                data: {
                  runId: context.runId,
                },
              });
            });
          };

          context.abortSignal.addEventListener("abort", abortListener, { once: true });
          runStates.set(context.runId, runState);

          const startupPort = parseFlagIntValue(launchArgs, "--port");
          context.emitDiagnostic?.({
            level: "info",
            message: "llama-server subprocess started.",
            data: {
              runId: context.runId,
              ...(startupPort !== null
                ? {
                    port: startupPort,
                  }
                : {}),
            },
          });

          void runState.terminationPromise
            .then((termination) => {
              const activeRunState = runStates.get(context.runId);
              if (activeRunState !== runState) {
                return;
              }

              runStates.delete(context.runId);
              runState.removeAbortListener();

              const secret = runState.apiKey;
              const stderrExcerpt = redactSecret(
                runState.stderrBuffer.excerpt(dependencies.diagnosticExcerptChars),
                secret,
              );
              const stdoutExcerpt = redactSecret(
                runState.stdoutBuffer.excerpt(dependencies.diagnosticExcerptChars),
                secret,
              );
              runState.apiKey = "";

              if (termination.kind === "error") {
                context.emitDiagnostic?.({
                  level: "error",
                  message: "llama-server subprocess terminated with an internal process error.",
                  data: {
                    runId: context.runId,
                    reason: redactSecret(termination.error.message, secret),
                    ...(stderrExcerpt.length > 0
                      ? {
                          stderrExcerpt,
                        }
                      : {}),
                    ...(stdoutExcerpt.length > 0
                      ? {
                          stdoutExcerpt,
                        }
                      : {}),
                  },
                });
                return;
              }

              if (termination.code === 0) {
                return;
              }

              context.emitDiagnostic?.({
                level: "warn",
                message: "llama-server subprocess exited unexpectedly.",
                data: {
                  runId: context.runId,
                  ...(termination.code !== null
                    ? {
                        exitCode: termination.code,
                      }
                    : {}),
                  ...(termination.signal !== null
                    ? {
                        signal: termination.signal,
                      }
                    : {}),
                  ...(stderrExcerpt.length > 0
                    ? {
                        stderrExcerpt,
                      }
                    : {}),
                  ...(stdoutExcerpt.length > 0
                    ? {
                        stdoutExcerpt,
                      }
                    : {}),
                },
              });
            })
            .catch((error) => {
              context.emitDiagnostic?.({
                level: "warn",
                message:
                  "llama-server termination observer failed while handling process shutdown diagnostics.",
                data: {
                  runId: context.runId,
                  reason: redactSecret(toError(error).message, runState.apiKey),
                },
              });
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
        const readinessError = toError(error);
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

function createDependencies(
  overrides: Partial<StarterLlamaCppPluginDependencies>,
): StarterLlamaCppPluginDependencies {
  const discoverSupportedServerFlagsImpl =
    overrides.discoverSupportedServerFlags ?? discoverSupportedServerFlags;
  let cachedSupportedServerFlagsPromise: Promise<ReadonlySet<string>> | null = null;

  const discoverSupportedServerFlagsWithCache = async (): Promise<ReadonlySet<string>> => {
    if (!cachedSupportedServerFlagsPromise) {
      cachedSupportedServerFlagsPromise = discoverSupportedServerFlagsImpl().catch(
        (error: unknown) => {
          cachedSupportedServerFlagsPromise = null;
          throw error;
        },
      );
    }

    return cachedSupportedServerFlagsPromise;
  };

  return {
    spawnProcess: overrides.spawnProcess ?? spawn,
    allocateLoopbackPort: overrides.allocateLoopbackPort ?? allocateLoopbackPort,
    createApiKey:
      overrides.createApiKey ??
      (() => randomBytes(API_KEY_ENTROPY_BYTES).toString("base64url")),
    modelRoots: overrides.modelRoots ? [...overrides.modelRoots] : [],
    signalProcessGroup:
      overrides.signalProcessGroup ??
      ((pid, signal) => {
        process.kill(-pid, signal);
      }),
    discoverSupportedServerFlags: discoverSupportedServerFlagsWithCache,
    fetch: overrides.fetch ?? fetch,
    wait: overrides.wait ?? delay,
    now: overrides.now ?? Date.now,
    startupProbeWindowMs:
      overrides.startupProbeWindowMs ?? DEFAULT_STARTUP_PROBE_WINDOW_MS,
    startupRetryAttempts:
      overrides.startupRetryAttempts ?? DEFAULT_STARTUP_RETRY_ATTEMPTS,
    stopGracePeriodMs: overrides.stopGracePeriodMs ?? DEFAULT_STOP_GRACE_PERIOD_MS,
    killWaitTimeoutMs: overrides.killWaitTimeoutMs ?? DEFAULT_KILL_WAIT_TIMEOUT_MS,
    readinessPollIntervalMs:
      overrides.readinessPollIntervalMs ?? DEFAULT_READINESS_POLL_INTERVAL_MS,
    readinessTimeoutMs: overrides.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
    readinessRequestTimeoutMs:
      overrides.readinessRequestTimeoutMs ?? DEFAULT_READINESS_REQUEST_TIMEOUT_MS,
    bufferedLogChars: overrides.bufferedLogChars ?? DEFAULT_BUFFERED_LOG_CHARS,
    diagnosticExcerptChars:
      overrides.diagnosticExcerptChars ?? DEFAULT_DIAGNOSTIC_EXCERPT_CHARS,
  };
}

function assertApiKeyStrength(apiKey: string): void {
  if (apiKey.length < MIN_API_KEY_LENGTH) {
    throw new Error(
      `Generated llama-server API key is too short (${apiKey.length} chars). Expected at least ${MIN_API_KEY_LENGTH} chars (>=32 bytes entropy).`,
    );
  }
}

async function spawnLlamaServerAttempt(
  input: SpawnAttemptInput,
): Promise<SpawnAttemptResult> {
  const stdoutBuffer = new RollingTextBuffer(input.dependencies.bufferedLogChars);
  const stderrBuffer = new RollingTextBuffer(input.dependencies.bufferedLogChars);

  let subprocess: ChildProcessWithoutNullStreams;

  try {
    subprocess = input.dependencies.spawnProcess(input.command, input.args, {
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildSpawnEnvironment(input.environmentOverrides),
    });
  } catch (error) {
    const startupError = toError(error);

    return {
      ok: false,
      failure: {
        reason: startupError.message,
        stdoutExcerpt: "",
        stderrExcerpt: "",
        exitCode: null,
        signal: null,
      },
    };
  }

  attachOutputBuffer(subprocess.stdout, stdoutBuffer);
  attachOutputBuffer(subprocess.stderr, stderrBuffer);
  subprocess.unref();

  const terminationPromise = createTerminationPromise(subprocess);
  const startupTermination = await waitForTermination(
    terminationPromise,
    input.dependencies.startupProbeWindowMs,
  );

  if (startupTermination === null) {
    return {
      ok: true,
      state: {
        process: subprocess,
        terminationPromise,
        stdoutBuffer,
        stderrBuffer,
      },
    };
  }

  if (startupTermination.kind === "error") {
    return {
      ok: false,
      failure: {
        reason: startupTermination.error.message,
        stdoutExcerpt: redactSecret(
          stdoutBuffer.excerpt(input.dependencies.diagnosticExcerptChars),
          input.apiKey,
        ),
        stderrExcerpt: redactSecret(
          stderrBuffer.excerpt(input.dependencies.diagnosticExcerptChars),
          input.apiKey,
        ),
        exitCode: null,
        signal: null,
      },
    };
  }

  return {
    ok: false,
    failure: {
      reason:
        startupTermination.code === null
          ? "llama-server exited during startup."
          : `llama-server exited during startup with code ${startupTermination.code}.`,
      stdoutExcerpt: redactSecret(
        stdoutBuffer.excerpt(input.dependencies.diagnosticExcerptChars),
        input.apiKey,
      ),
      stderrExcerpt: redactSecret(
        stderrBuffer.excerpt(input.dependencies.diagnosticExcerptChars),
        input.apiKey,
      ),
      exitCode: startupTermination.code,
      signal: startupTermination.signal,
    },
  };
}

function buildStartupFailureError(input: {
  runId: string;
  command: string;
  args: string[];
  failure: LlamaServerStartupFailure;
  apiKey: string;
}): EngineStartFailedError {
  const redactedArgs = redactLaunchArgs(input.args);
  const commandSummary = [input.command, ...redactedArgs].join(" ");
  const details: Record<string, unknown> = {
    code: "ENGINE_START_FAILED",
    reason: redactSecret(input.failure.reason, input.apiKey),
    launchCommand: commandSummary,
  };

  const messageParts: string[] = [];

  messageParts.push(
    `Unable to start llama-server for run '${input.runId}'. ${details.reason as string}`,
  );

  if (input.failure.stderrExcerpt.length > 0) {
    details.stderrExcerpt = input.failure.stderrExcerpt;
    messageParts.push(`stderr excerpt: ${input.failure.stderrExcerpt}`);
  }

  if (input.failure.stdoutExcerpt.length > 0) {
    details.stdoutExcerpt = input.failure.stdoutExcerpt;
    messageParts.push(`stdout excerpt: ${input.failure.stdoutExcerpt}`);
  }

  if (input.failure.exitCode !== null) {
    details.exitCode = input.failure.exitCode;
  }

  if (input.failure.signal !== null) {
    details.signal = input.failure.signal;
  }

  messageParts.push(`launch command: ${commandSummary}`);

  return new EngineStartFailedErrorClass(
    `ENGINE_START_FAILED: ${messageParts.join(" ")}`,
    details,
  );
}

async function stopRunState(
  runState: LlamaServerRunState,
  input: StopRunStateInput,
): Promise<void> {
  runState.removeAbortListener();

  try {
    const pid = runState.process.pid;
    if (pid === undefined) {
      return;
    }

    const termSignalError = signalProcessGroup(pid, "SIGTERM", input.dependencies);
    if (termSignalError && !isMissingProcessError(termSignalError)) {
      throw buildStopFailureError(runState, {
        ...input,
        reason: `Failed to send SIGTERM: ${termSignalError.message}`,
      });
    }

    const gracefulTermination = await waitForTermination(
      runState.terminationPromise,
      input.dependencies.stopGracePeriodMs,
    );

    if (gracefulTermination !== null) {
      return;
    }

    input.emitDiagnostic?.({
      level: "warn",
      message: "llama-server did not stop after SIGTERM; escalating to SIGKILL.",
      data: {
        runId: input.runId,
        reason: input.reason,
      },
    });

    const killSignalError = signalProcessGroup(pid, "SIGKILL", input.dependencies);
    if (killSignalError && !isMissingProcessError(killSignalError)) {
      throw buildStopFailureError(runState, {
        ...input,
        reason: `Failed to send SIGKILL: ${killSignalError.message}`,
      });
    }

    const forcedTermination = await waitForTermination(
      runState.terminationPromise,
      input.dependencies.killWaitTimeoutMs,
    );

    if (forcedTermination !== null) {
      return;
    }

    throw buildStopFailureError(runState, {
      ...input,
      reason:
        `llama-server process group did not exit within ` +
        `${input.dependencies.stopGracePeriodMs + input.dependencies.killWaitTimeoutMs}ms after SIGTERM/SIGKILL.`,
    });
  } finally {
    runState.apiKey = "";
    runState.healthRequestHeaders = {};
  }
}

function buildStopFailureError(
  runState: LlamaServerRunState,
  input: StopRunStateInput,
): Error {
  const stderrExcerpt = redactSecret(
    runState.stderrBuffer.excerpt(input.dependencies.diagnosticExcerptChars),
    runState.apiKey,
  );
  const stdoutExcerpt = redactSecret(
    runState.stdoutBuffer.excerpt(input.dependencies.diagnosticExcerptChars),
    runState.apiKey,
  );

  const details = [
    `Failed to stop llama-server for run '${input.runId}'. ${input.reason}`,
  ];

  if (stderrExcerpt.length > 0) {
    details.push(`stderr excerpt: ${stderrExcerpt}`);
  }

  if (stdoutExcerpt.length > 0) {
    details.push(`stdout excerpt: ${stdoutExcerpt}`);
  }

  return new Error(details.join(" "));
}

function signalProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  dependencies: StarterLlamaCppPluginDependencies,
): Error | null {
  try {
    dependencies.signalProcessGroup(pid, signal);
    return null;
  } catch (error) {
    return toError(error);
  }
}

function isMissingProcessError(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === "ESRCH";
}

function isRetryableStartupFailure(failure: LlamaServerStartupFailure): boolean {
  if (failure.exitCode === 48 || failure.exitCode === 98) {
    return true;
  }

  const normalizedReason = `${failure.reason}\n${failure.stderrExcerpt}`.toLowerCase();

  return /address already in use|eaddrinuse|failed to bind|cannot bind|bind\(/.test(
    normalizedReason,
  );
}

async function waitForTermination(
  terminationPromise: Promise<ProcessTermination>,
  timeoutMs: number,
): Promise<ProcessTermination | null> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      terminationPromise,
      new Promise<null>((resolve) => {
        timeoutHandle = setTimeout(() => {
          resolve(null);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function createTerminationPromise(
  subprocess: ChildProcessWithoutNullStreams,
): Promise<ProcessTermination> {
  return new Promise((resolve) => {
    const onError = (error: Error) => {
      cleanup();
      resolve({
        kind: "error",
        error,
      });
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({
        kind: "exit",
        code,
        signal,
      });
    };

    const cleanup = () => {
      subprocess.off("error", onError);
      subprocess.off("exit", onExit);
    };

    subprocess.once("error", onError);
    subprocess.once("exit", onExit);
  });
}

function attachOutputBuffer(stream: Readable | null, outputBuffer: RollingTextBuffer): void {
  if (!stream) {
    return;
  }

  stream.setEncoding("utf8");
  stream.on("data", (chunk: string | Buffer) => {
    outputBuffer.append(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });
}

function buildSpawnEnvironment(
  environmentOverrides: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  if (!environmentOverrides) {
    return process.env;
  }

  if (hasRestrictedEnvironmentOverrides(environmentOverrides)) {
    throw new Error(
      "llama.cpp launch config includes restricted environment overrides.",
    );
  }

  return {
    ...process.env,
    ...environmentOverrides,
  };
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  server.unref();

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };

    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({
      host: LOOPBACK_HOST,
      port: 0,
      exclusive: true,
    });
  });

  const address = server.address();

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  // This has an unavoidable TOCTOU window between releasing the probe socket and
  // the engine process binding. Startup retries handle transient collisions.

  if (!address || typeof address === "string" || address.port <= 0) {
    throw new Error("Unable to allocate a loopback port for llama-server startup.");
  }

  return address.port;
}

function parseFlagIntValue(args: string[], flag: string): number | null {
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

function extractRequiredFlagValue(args: string[], flag: string): string {
  const value = extractFlagValue(args, flag);
  if (!value) {
    throw new Error(`llama.cpp launch config is missing required flag '${flag}'.`);
  }

  return value;
}

function extractFlagValue(args: string[], flag: string): string | null {
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

function replaceRequiredFlagValue(
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

function redactLaunchArgs(args: string[]): string[] {
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

function redactSecret(input: string, secret: string): string {
  if (secret.length === 0 || input.length === 0) {
    return input;
  }

  return input.split(secret).join(REDACTED_VALUE);
}

class RollingTextBuffer {
  private value = "";

  constructor(private readonly maxChars: number) {}

  append(chunk: string): void {
    if (chunk.length === 0) {
      return;
    }

    this.value += chunk;
    if (this.value.length > this.maxChars) {
      this.value = this.value.slice(-this.maxChars);
    }
  }

  excerpt(maxChars: number): string {
    if (this.value.length <= maxChars) {
      return this.value.trim();
    }

    return this.value.slice(-maxChars).trim();
  }
}

async function validateServerArgs(
  serverArgs: string[],
  validationMode: EngineValidationMode,
  dependencies: StarterLlamaCppPluginDependencies,
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
    supportedFlags = await dependencies.discoverSupportedServerFlags();
  } catch (error) {
    const reason = normalizeIssueMessage(toError(error).message);
    issues.push({
      code: "SERVER_ARG_FLAG_DISCOVERY_FAILED",
      message:
        "Unable to parse supported flags from `llama-server --help` in strict mode. " +
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

function validateRequestParams(
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

async function validateModelIdentifier(
  modelIdentifier: string,
  modelRoots: readonly string[],
): Promise<ModelIdentifierValidationResult> {
  const issues: EngineValidationIssue[] = [];
  const path = "model.identifier";
  const normalized = modelIdentifier.trim();

  if (normalized.length === 0) {
    issues.push({
      code: "MODEL_IDENTIFIER_EMPTY",
      message: "model.identifier must not be empty.",
      path,
    });

    return {
      ok: false,
      issues,
    };
  }

  if (normalized.includes("://")) {
    issues.push({
      code: "MODEL_IDENTIFIER_NOT_LOCAL_PATH",
      message: "model.identifier must be a local filesystem path.",
      path,
    });
  }

  if (!normalized.toLowerCase().endsWith(".gguf")) {
    issues.push({
      code: "MODEL_IDENTIFIER_EXTENSION_INVALID",
      message: "model.identifier must point to a .gguf file.",
      path,
    });
  }

  const absolutePath = resolve(normalized);
  let canonicalModelPath: string;

  try {
    canonicalModelPath = await realpath(absolutePath);
  } catch {
    issues.push({
      code: "MODEL_IDENTIFIER_NOT_FOUND",
      message: "model.identifier does not exist.",
      path,
    });

    return {
      ok: false,
      issues,
    };
  }

  let modelStats: Awaited<ReturnType<typeof stat>>;
  try {
    modelStats = await stat(canonicalModelPath);
  } catch {
    issues.push({
      code: "MODEL_IDENTIFIER_NOT_FOUND",
      message: "model.identifier is not accessible.",
      path,
    });

    return {
      ok: false,
      issues,
    };
  }

  if (!modelStats.isFile()) {
    issues.push({
      code: "MODEL_IDENTIFIER_NOT_FILE",
      message: "model.identifier must reference a file, not a directory.",
      path,
    });
  }

  try {
    await access(canonicalModelPath, fsConstants.R_OK);
  } catch {
    issues.push({
      code: "MODEL_IDENTIFIER_NOT_READABLE",
      message: "model.identifier must reference a readable file.",
      path,
    });
  }

  if (modelRoots.length > 0) {
    const normalizedModelRoots = await resolveModelRoots([...modelRoots], path, issues);

    if (
      normalizedModelRoots.length > 0 &&
      !normalizedModelRoots.some((rootPath) => isPathInsideRoot(canonicalModelPath, rootPath))
    ) {
      issues.push({
        code: "MODEL_IDENTIFIER_OUTSIDE_ALLOWED_ROOTS",
        message:
          "model.identifier is outside CHIMERA_MODEL_ROOTS after resolving symlinks.",
        path,
      });
    }
  }

  if (issues.length > 0) {
    return {
      ok: false,
      issues,
    };
  }

  return {
    ok: true,
    normalizedIdentifier: canonicalModelPath,
  };
}

function buildHealthUrl(launchArgs: string[]): string {
  const host = extractRequiredFlagValue(launchArgs, "--host");
  const port = parseFlagIntValue(launchArgs, "--port");
  if (port === null) {
    throw new Error("llama.cpp launch config is missing a valid --port value.");
  }

  return `http://${host}:${port}/health`;
}

function buildHealthRequestHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

async function waitForReadinessProbe(
  runState: LlamaServerRunState,
  abortSignal: AbortSignal,
  dependencies: StarterLlamaCppPluginDependencies,
): Promise<void> {
  const deadlineMs = dependencies.now() + dependencies.readinessTimeoutMs;
  const terminationGuard = runState.terminationPromise.then<ReadinessProbeFailure>((termination) => ({
    kind: "failed",
    reason: buildReadinessTerminationReason(termination),
  }));

  while (true) {
    if (abortSignal.aborted) {
      throw new Error("Run was aborted while waiting for llama-server readiness.");
    }

    const probeResult = await Promise.race([
      probeReadiness(runState, dependencies),
      terminationGuard,
    ]);
    if (probeResult.kind === "ready") {
      return;
    }

    if (probeResult.kind === "failed") {
      throw new Error(probeResult.reason);
    }

    if (dependencies.now() >= deadlineMs) {
      throw new Error(
        `Timed out waiting ${dependencies.readinessTimeoutMs}ms for llama-server readiness at ${runState.healthUrl}.`,
      );
    }

    await dependencies.wait(dependencies.readinessPollIntervalMs);
  }
}

function buildReadinessTerminationReason(termination: ProcessTermination): string {
  if (termination.kind === "error") {
    return `llama-server process terminated before readiness: ${termination.error.message}`;
  }

  if (termination.code !== null) {
    return `llama-server process terminated before readiness with exit code ${termination.code}.`;
  }

  if (termination.signal !== null) {
    return `llama-server process terminated before readiness with signal ${termination.signal}.`;
  }

  return "llama-server process terminated before readiness.";
}

async function probeReadiness(
  runState: LlamaServerRunState,
  dependencies: StarterLlamaCppPluginDependencies,
): Promise<ReadinessProbeResult> {
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    timeoutController.abort();
  }, dependencies.readinessRequestTimeoutMs);

  try {
    const response = await dependencies.fetch(runState.healthUrl, {
      method: "GET",
      headers: runState.healthRequestHeaders,
      signal: timeoutController.signal,
    });

    if (response.ok) {
      return {
        kind: "ready",
      };
    }

    if (response.status === 503) {
      return {
        kind: "retry",
      };
    }

    const bodyExcerpt = await readResponseExcerpt(response, READINESS_ERROR_EXCERPT_CHARS);
    return {
      kind: "failed",
      reason:
        `llama-server readiness check returned HTTP ${response.status}.` +
        (bodyExcerpt.length > 0 ? ` Response excerpt: ${bodyExcerpt}` : ""),
    };
  } catch (error) {
    const probeError = toError(error);
    if (isTransientReadinessError(probeError)) {
      return {
        kind: "retry",
      };
    }

    return {
      kind: "failed",
      reason: `llama-server readiness probe failed: ${probeError.message}`,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function buildEngineStartFailedError(input: {
  runId: string;
  reason: string;
  runState: LlamaServerRunState;
  dependencies: StarterLlamaCppPluginDependencies;
}): EngineStartFailedError {
  const secret = input.runState.apiKey;
  const stderrExcerpt = redactSecret(
    input.runState.stderrBuffer.excerpt(input.dependencies.diagnosticExcerptChars),
    secret,
  );
  const stdoutExcerpt = redactSecret(
    input.runState.stdoutBuffer.excerpt(input.dependencies.diagnosticExcerptChars),
    secret,
  );

  const details: Record<string, unknown> = {
    code: "ENGINE_START_FAILED",
    reason: redactSecret(input.reason, secret),
    ...(stderrExcerpt.length > 0
      ? {
          stderrExcerpt,
        }
      : {}),
    ...(stdoutExcerpt.length > 0
      ? {
          stdoutExcerpt,
        }
      : {}),
  };

  return new EngineStartFailedErrorClass(
    `ENGINE_START_FAILED: ${details.reason as string}`,
    details,
  );
}

async function discoverSupportedServerFlags(): Promise<ReadonlySet<string>> {
  const output = await captureCommandOutput(
    LLAMA_SERVER_COMMAND,
    ["--help"],
    DEFAULT_SERVER_HELP_TIMEOUT_MS,
    DEFAULT_MAX_HELP_OUTPUT_CHARS,
  );

  const supportedFlags = parseSupportedServerFlags(`${output.stdout}\n${output.stderr}`);
  if (supportedFlags.size > 0) {
    return supportedFlags;
  }

  throw new Error(
    "Unable to parse supported flags from `llama-server --help` output.",
  );
}

async function captureCommandOutput(
  command: string,
  args: string[],
  timeoutMs: number,
  maxCharsPerStream: number,
): Promise<{
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      rejectPromise(toError(error));
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      child.off("error", onError);
      child.off("close", onClose);
    };

    const onError = (error: Error) => {
      cleanup();
      rejectPromise(error);
    };

    const onClose = () => {
      cleanup();

      if (timedOut) {
        rejectPromise(
          new Error(
            `Timed out after ${timeoutMs}ms while running '${command} ${args.join(" ")}'.`,
          ),
        );
        return;
      }

      // Some llama-server builds exit non-zero for --help while still emitting
      // complete flag documentation; callers validate parsed flag content.

      resolvePromise({
        stdout,
        stderr,
      });
    };

    child.once("error", onError);
    child.once("close", onClose);

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string | Buffer) => {
        stdout = appendBounded(stdout, chunk.toString(), maxCharsPerStream);
      });
    }

    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string | Buffer) => {
        stderr = appendBounded(stderr, chunk.toString(), maxCharsPerStream);
      });
    }
  });
}

function parseSupportedServerFlags(helpOutput: string): ReadonlySet<string> {
  const supportedFlags = new Set<string>();
  const flagPattern = /(?:^|\s)(--[a-z0-9][a-z0-9-]*|-[a-z0-9])(?=\s|=|,|\]|$)/gi;

  for (const match of helpOutput.matchAll(flagPattern)) {
    const flag = match[1]?.trim().toLowerCase();
    if (!flag) {
      continue;
    }

    supportedFlags.add(flag);
  }

  return supportedFlags;
}

function appendBounded(existing: string, nextChunk: string, maxChars: number): string {
  const combined = `${existing}${nextChunk}`;
  if (combined.length <= maxChars) {
    return combined;
  }

  return combined.slice(-maxChars);
}

function isTransientReadinessError(error: Error): boolean {
  const errorWithCode = error as NodeJS.ErrnoException;
  if (error.name === "AbortError") {
    return true;
  }

  const code = errorWithCode.code;
  if (
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND" ||
    code === "EHOSTUNREACH"
  ) {
    return true;
  }

  const normalizedMessage = error.message.toLowerCase();
  return (
    normalizedMessage.includes("connection refused") ||
    normalizedMessage.includes("fetch failed") ||
    normalizedMessage.includes("timed out") ||
    normalizedMessage.includes("aborted") ||
    normalizedMessage.includes("socket hang up")
  );
}

async function readResponseExcerpt(response: Response, maxChars: number): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let excerpt = "";

  try {
    while (excerpt.length < maxChars) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      excerpt += decoder.decode(chunk.value, {
        stream: true,
      });
    }

    excerpt += decoder.decode();
    return normalizeIssueMessage(excerpt).slice(0, maxChars);
  } catch {
    return "";
  } finally {
    void reader.cancel().catch(() => {
      return;
    });
  }
}

async function resolveModelRoots(
  modelRoots: string[],
  issuePath: string,
  issues: EngineValidationIssue[],
): Promise<string[]> {
  const normalizedRoots = new Set<string>();

  for (const [index, root] of modelRoots.entries()) {
    const absoluteRoot = resolve(root);
    let canonicalRoot: string;

    try {
      canonicalRoot = await realpath(absoluteRoot);
    } catch {
      issues.push({
        code: "MODEL_ROOT_NOT_FOUND",
        message: `CHIMERA_MODEL_ROOTS entry at index ${index} does not exist.`,
        path: issuePath,
      });
      continue;
    }

    let rootStats: Awaited<ReturnType<typeof stat>>;
    try {
      rootStats = await stat(canonicalRoot);
    } catch {
      issues.push({
        code: "MODEL_ROOT_NOT_FOUND",
        message: `CHIMERA_MODEL_ROOTS entry at index ${index} is not accessible.`,
        path: issuePath,
      });
      continue;
    }

    if (!rootStats.isDirectory()) {
      issues.push({
        code: "MODEL_ROOT_NOT_DIRECTORY",
        message: `CHIMERA_MODEL_ROOTS entry at index ${index} is not a directory.`,
        path: issuePath,
      });
      continue;
    }

    normalizedRoots.add(canonicalRoot);
  }

  return Array.from(normalizedRoots);
}

function isPathInsideRoot(filePath: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
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
      message:
        `requestParams.${options.label} must be between ${options.min} and ${options.max}.`,
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

function normalizeIssueMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  return new Error(`Unexpected non-error value: ${String(value)}`);
}
