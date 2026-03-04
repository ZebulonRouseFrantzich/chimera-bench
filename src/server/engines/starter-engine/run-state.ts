/**
 * Runtime state orchestration for starter-engine process lifecycle.
 *
 * This module owns abort wiring, termination diagnostics, and shutdown
 * escalation from SIGTERM to SIGKILL.
 */
import type { EngineRuntimeContext } from "../engine-plugin.ts";
import type {
  LlamaServerRunState,
  StarterLlamaCppPluginDependencies,
  StopRunStateInput,
} from "./types.ts";
import { waitForTermination } from "./spawn.ts";
import { redactSecret, toError } from "./utils.ts";

const REMOTE_CLEANUP_TIMEOUT_MS = 5_000;
const REMOTE_CLEANUP_GRACE_MS = 250;
const REMOTE_CLEANUP_MAX_BUFFERED_CHARS = 1_024;
const REMOTE_CLEANUP_DIAGNOSTIC_EXCERPT_CHARS = 512;

export function activateRunState(input: {
  context: EngineRuntimeContext;
  runState: LlamaServerRunState;
  runStates: Map<string, LlamaServerRunState>;
  dependencies: StarterLlamaCppPluginDependencies;
}): void {
  let abortListenerRemoved = false;

  const abortListener = () => {
    const activeRunState = input.runStates.get(input.context.runId);
    if (activeRunState !== input.runState) {
      return;
    }

    input.runStates.delete(input.context.runId);
    void stopRunState(input.runState, {
      runId: input.context.runId,
      reason: "abort-signal",
      emitDiagnostic: input.context.emitDiagnostic,
      dependencies: input.dependencies,
    }).catch(() => {
      input.context.emitDiagnostic?.({
        level: "warn",
        message:
          "llama.cpp process cleanup failed after abort signal; check server logs for details.",
        data: {
          runId: input.context.runId,
        },
      });
    });
  };

  const removeAbortListener = () => {
    if (abortListenerRemoved) {
      return;
    }

    abortListenerRemoved = true;
    input.context.abortSignal.removeEventListener("abort", abortListener);
  };

  input.runState.removeAbortListener = removeAbortListener;
  input.context.abortSignal.addEventListener("abort", abortListener, {
    once: true,
  });
  input.runStates.set(input.context.runId, input.runState);

  input.context.emitDiagnostic?.({
    level: "info",
    message:
      input.runState.mode === "ssh"
        ? "SSH-managed remote llama-server session started."
        : "llama-server subprocess started.",
    data: {
      runId: input.context.runId,
      ...(input.runState.startupDiagnosticData ?? {}),
    },
  });

  void input.runState.terminationPromise
    .then((termination) => {
      const activeRunState = input.runStates.get(input.context.runId);
      if (activeRunState !== input.runState) {
        return;
      }

      input.runStates.delete(input.context.runId);
      input.runState.removeAbortListener();

      const secret = input.runState.apiKey;
      const stderrExcerpt = redactSecret(
        input.runState.stderrBuffer.excerpt(input.dependencies.diagnosticExcerptChars),
        secret,
      );
      const stdoutExcerpt = redactSecret(
        input.runState.stdoutBuffer.excerpt(input.dependencies.diagnosticExcerptChars),
        secret,
      );
      input.runState.apiKey = "";

      if (termination.kind === "error") {
        input.context.emitDiagnostic?.({
          level: "error",
          message:
            input.runState.mode === "ssh"
              ? "SSH-managed remote llama-server session terminated with an internal process error."
              : "llama-server subprocess terminated with an internal process error.",
          data: {
            runId: input.context.runId,
            reason: redactSecret(termination.error.message, secret),
            ...(input.runState.startupDiagnosticData ?? {}),
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

      input.context.emitDiagnostic?.({
        level: "warn",
        message:
          input.runState.mode === "ssh"
            ? "SSH-managed remote llama-server session exited unexpectedly."
            : "llama-server subprocess exited unexpectedly.",
        data: {
          runId: input.context.runId,
          ...(input.runState.startupDiagnosticData ?? {}),
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
      input.context.emitDiagnostic?.({
        level: "warn",
        message:
          "llama-server termination observer failed while handling process shutdown diagnostics.",
        data: {
          runId: input.context.runId,
          reason: redactSecret(toError(error).message, input.runState.apiKey),
        },
      });
    });
}

export async function stopRunState(
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
    await cleanupRemoteSshRuntime(runState, input);

    if (runState.remotePortReservation) {
      input.dependencies.releaseRemoteSshPort(
        runState.remotePortReservation.destinationKey,
        runState.remotePortReservation.remotePort,
      );
      delete runState.remotePortReservation;
    }

    runState.apiKey = "";
    runState.healthRequestHeaders = {};
    input.emitDiagnostic?.({
      level: "info",
      message:
        runState.mode === "ssh"
          ? "SSH-managed remote llama-server cleanup complete."
          : "llama-server cleanup complete.",
      data: {
        runId: input.runId,
        reason: input.reason,
        ...(runState.startupDiagnosticData ?? {}),
      },
    });
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

  const details = [`Failed to stop llama-server for run '${input.runId}'. ${input.reason}`];

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

async function cleanupRemoteSshRuntime(
  runState: LlamaServerRunState,
  input: StopRunStateInput,
): Promise<void> {
  if (runState.mode !== "ssh" || !runState.sshManagedRuntime) {
    return;
  }

  const pattern = buildRemoteLlamaServerPattern(runState.sshManagedRuntime.remotePort);
  const termExitCode = await runRemoteCleanupSignal({
    signal: "TERM",
    pattern,
    runState,
    stopInput: input,
  });

  if (termExitCode !== 0) {
    return;
  }

  await input.dependencies.wait(REMOTE_CLEANUP_GRACE_MS);
  await runRemoteCleanupSignal({
    signal: "KILL",
    pattern,
    runState,
    stopInput: input,
  });
}

async function runRemoteCleanupSignal(input: {
  signal: "TERM" | "KILL";
  pattern: string;
  runState: LlamaServerRunState;
  stopInput: StopRunStateInput;
}): Promise<number | null> {
  const { signal, pattern, runState, stopInput } = input;
  const sshManagedRuntime = runState.sshManagedRuntime;
  if (!sshManagedRuntime) {
    return null;
  }

  try {
    const result = await stopInput.dependencies.executeSshCommand({
      profile: sshManagedRuntime.profile,
      remoteArgv: ["pkill", `-${signal}`, "-f", pattern],
      allowNonZeroExit: true,
      overallTimeoutMs: REMOTE_CLEANUP_TIMEOUT_MS,
      maxBufferedChars: REMOTE_CLEANUP_MAX_BUFFERED_CHARS,
      diagnosticExcerptChars: REMOTE_CLEANUP_DIAGNOSTIC_EXCERPT_CHARS,
    });

    const exitCode = result.exitCode ?? 0;
    stopInput.emitDiagnostic?.({
      level: "info",
      message: "SSH remote llama-server cleanup signal dispatched.",
      data: {
        runId: stopInput.runId,
        signal,
        remotePort: sshManagedRuntime.remotePort,
        ...(exitCode !== 0
          ? {
              exitCode,
            }
          : {}),
      },
    });

    return exitCode;
  } catch (error) {
    stopInput.emitDiagnostic?.({
      level: "warn",
      message: "SSH remote llama-server cleanup command failed.",
      data: {
        runId: stopInput.runId,
        signal,
        remotePort: sshManagedRuntime.remotePort,
        reason: redactSecret(toError(error).message, runState.apiKey),
      },
    });
    return null;
  }
}

function buildRemoteLlamaServerPattern(remotePort: number): string {
  return `llama-server.*--host 127.0.0.1 --port ${remotePort}`;
}
