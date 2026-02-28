import { spawn } from "node:child_process";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { Readable } from "node:stream";
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
import {
  ENGINE_PLUGIN_API_VERSION,
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
  state: Omit<LlamaServerRunState, "apiKey" | "removeAbortListener">;
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
  signalProcessGroup: (pid: number, signal: NodeJS.Signals) => void;
  startupProbeWindowMs: number;
  startupRetryAttempts: number;
  stopGracePeriodMs: number;
  killWaitTimeoutMs: number;
  bufferedLogChars: number;
  diagnosticExcerptChars: number;
}

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

      const port = await dependencies.allocateLoopbackPort();
      const apiKey = dependencies.createApiKey();
      assertApiKeyStrength(apiKey);

      return {
        command: LLAMA_SERVER_COMMAND,
        args: [
          "--model",
          runConfig.model.identifier,
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
      if (!runStates.has(context.runId)) {
        throw new Error(
          `llama-server runtime is not active for run '${context.runId}'. Call start() first.`,
        );
      }
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
  return {
    spawnProcess: overrides.spawnProcess ?? spawn,
    allocateLoopbackPort: overrides.allocateLoopbackPort ?? allocateLoopbackPort,
    createApiKey:
      overrides.createApiKey ??
      (() => randomBytes(API_KEY_ENTROPY_BYTES).toString("base64url")),
    signalProcessGroup:
      overrides.signalProcessGroup ??
      ((pid, signal) => {
        process.kill(-pid, signal);
      }),
    startupProbeWindowMs:
      overrides.startupProbeWindowMs ?? DEFAULT_STARTUP_PROBE_WINDOW_MS,
    startupRetryAttempts:
      overrides.startupRetryAttempts ?? DEFAULT_STARTUP_RETRY_ATTEMPTS,
    stopGracePeriodMs: overrides.stopGracePeriodMs ?? DEFAULT_STOP_GRACE_PERIOD_MS,
    killWaitTimeoutMs: overrides.killWaitTimeoutMs ?? DEFAULT_KILL_WAIT_TIMEOUT_MS,
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
}): Error {
  const redactedArgs = redactLaunchArgs(input.args);
  const commandSummary = [input.command, ...redactedArgs].join(" ");
  const details: string[] = [];

  details.push(
    `Unable to start llama-server for run '${input.runId}'. ${redactSecret(input.failure.reason, input.apiKey)}`,
  );

  if (input.failure.stderrExcerpt.length > 0) {
    details.push(`stderr excerpt: ${input.failure.stderrExcerpt}`);
  }

  if (input.failure.stdoutExcerpt.length > 0) {
    details.push(`stdout excerpt: ${input.failure.stdoutExcerpt}`);
  }

  details.push(`launch command: ${commandSummary}`);

  return new Error(details.join(" "));
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

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  return new Error(`Unexpected non-error value: ${String(value)}`);
}
