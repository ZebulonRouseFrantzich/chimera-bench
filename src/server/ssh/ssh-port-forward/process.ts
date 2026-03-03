/**
 * SSH port-forward subprocess startup and lifecycle handling.
 *
 * This module owns subprocess spawn/teardown, readiness coordination, and
 * construction of stable execution errors with redacted diagnostics.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { toError } from "../../error-utils.ts";
import { classifySshFailureGuidance } from "../ssh-exec.ts";
import {
  attachOutputStream,
  cancelSubprocess,
  createTerminationPromise,
  redactArray,
  redactText,
  RollingTextBuffer,
  type SubprocessTermination,
} from "../ssh-process-utils.ts";
import { buildSshPortForwardArgv } from "./argv.ts";
import {
  buildStartupError,
  hasRemoteLoopbackConnectFailure,
  waitForForwardReady,
} from "./startup.ts";
import type {
  SshPortForwardDependencies,
  SshPortForwardErrorDetails,
  SshPortForwardHandle,
  SshPortForwardRequest,
} from "./types.ts";
import {
  SshPortForwardExecutionError,
  SshPortForwardValidationError,
} from "./types.ts";

const CANCEL_KILL_GRACE_PERIOD_MS = 500;
const STARTUP_POLL_INTERVAL_MS = 75;

interface StartSshPortForwardOnceInput {
  request: SshPortForwardRequest;
  dependencies: SshPortForwardDependencies;
  localPort: number;
  startupTimeoutMs: number;
  maxBufferedChars: number;
  diagnosticExcerptChars: number;
  redactions: readonly string[];
}

export async function startSshPortForwardOnce(
  input: StartSshPortForwardOnceInput,
): Promise<SshPortForwardHandle> {
  const argv = buildSshPortForwardArgv({
    profile: input.request.profile,
    localPort: input.localPort,
    remotePort: input.request.remotePort,
  });

  const [command, ...args] = argv;
  if (!command) {
    throw new SshPortForwardValidationError("SSH command argv cannot be empty.");
  }

  let subprocess: ChildProcessWithoutNullStreams;
  try {
    subprocess = input.dependencies.spawnProcess(command, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new SshPortForwardExecutionError(
      `Failed to start ssh process: ${toError(error).message}`,
      {
        argv: redactArray(argv, input.redactions),
        localPort: input.localPort,
        remotePort: input.request.remotePort,
        stdoutExcerpt: "",
        stderrExcerpt: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    );
  }

  try {
    subprocess.stdin.end();
  } catch {
    // Best effort: keep stdin closed for non-interactive ssh usage.
  }

  const stdoutBuffer = new RollingTextBuffer(input.maxBufferedChars);
  const stderrBuffer = new RollingTextBuffer(input.maxBufferedChars);

  attachOutputStream({
    stream: subprocess.stdout,
    outputBuffer: stdoutBuffer,
    redactions: input.redactions,
    ...(input.request.onStdoutChunk
      ? {
          onChunk: input.request.onStdoutChunk,
        }
      : {}),
  });
  attachOutputStream({
    stream: subprocess.stderr,
    outputBuffer: stderrBuffer,
    redactions: input.redactions,
    ...(input.request.onStderrChunk
      ? {
          onChunk: input.request.onStderrChunk,
        }
      : {}),
  });

  let cancelled = false;
  let observedTermination: SubprocessTermination | null = null;
  const terminationPromise = createTerminationPromise(subprocess);

  const onAbort = () => {
    cancelled = true;
    // If the orchestrator process receives SIGKILL/OOM, child ssh processes can still
    // outlive this process. In the normal signal path, we proactively terminate ssh.
    cancelSubprocess(subprocess, {
      setTimer: input.dependencies.setTimer,
      clearTimer: input.dependencies.clearTimer,
      killGracePeriodMs: CANCEL_KILL_GRACE_PERIOD_MS,
    });
  };

  input.request.abortSignal?.addEventListener("abort", onAbort, {
    once: true,
  });
  void terminationPromise.then((termination) => {
    observedTermination = termination;
    input.request.abortSignal?.removeEventListener("abort", onAbort);
  });

  const getErrorDetails = (
    termination?: {
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
    },
  ): SshPortForwardErrorDetails => ({
    argv: redactArray(argv, input.redactions),
    localPort: input.localPort,
    remotePort: input.request.remotePort,
    stdoutExcerpt: stdoutBuffer.excerpt(input.diagnosticExcerptChars),
    stderrExcerpt: stderrBuffer.excerpt(input.diagnosticExcerptChars),
    stdoutTruncated: stdoutBuffer.wasTruncated(),
    stderrTruncated: stderrBuffer.wasTruncated(),
    ...(termination ? termination : {}),
  });

  const hasRemoteConnectionFailure = (): boolean => {
    const stderrExcerpt = stderrBuffer.excerpt(input.diagnosticExcerptChars);
    return hasRemoteLoopbackConnectFailure(stderrExcerpt);
  };

  try {
    await waitForForwardReady({
      localPort: input.localPort,
      startupTimeoutMs: input.startupTimeoutMs,
      pollIntervalMs: STARTUP_POLL_INTERVAL_MS,
      terminationPromise,
      probeForwardReady: input.dependencies.probeForwardReady,
      hasRemoteConnectionFailure,
      now: input.dependencies.now,
      setTimer: input.dependencies.setTimer,
      clearTimer: input.dependencies.clearTimer,
      ...(input.request.abortSignal
        ? {
            abortSignal: input.request.abortSignal,
          }
        : {}),
    });
  } catch (error) {
    cancelSubprocess(subprocess, {
      setTimer: input.dependencies.setTimer,
      clearTimer: input.dependencies.clearTimer,
      killGracePeriodMs: CANCEL_KILL_GRACE_PERIOD_MS,
    });
    const termination = await terminationPromise;
    throw buildStartupError({
      error,
      termination,
      getErrorDetails,
      startupTimeoutMs: input.startupTimeoutMs,
      remotePort: input.request.remotePort,
      redactions: input.redactions,
    });
  }

  if (observedTermination !== null) {
    throw buildStartupError({
      error: new Error("terminated"),
      termination: observedTermination,
      getErrorDetails,
      startupTimeoutMs: input.startupTimeoutMs,
      remotePort: input.request.remotePort,
      redactions: input.redactions,
    });
  }

  return {
    localPort: input.localPort,
    argv: redactArray(argv, input.redactions),
    waitForExit: async (): Promise<void> => {
      const termination = await terminationPromise;

      if (cancelled) {
        throw new SshPortForwardExecutionError("SSH port forward was cancelled.", {
          ...getErrorDetails(),
          ...(termination.kind === "exit"
            ? {
                exitCode: termination.code,
                signal: termination.signal,
              }
            : {}),
        });
      }

      if (termination.kind === "error") {
        throw new SshPortForwardExecutionError(
          `SSH port forward process failed: ${redactText(termination.error.message, input.redactions)}.`,
          getErrorDetails(),
        );
      }

      if (termination.code === 0) {
        return;
      }

      const stderrExcerpt = getErrorDetails().stderrExcerpt;
      const guidance = classifySshFailureGuidance(stderrExcerpt);
      const guidanceSentence = guidance ? ` ${guidance}` : "";
      const reason =
        termination.code === null
          ? `SSH port forward terminated by signal ${termination.signal ?? "unknown"}.`
          : `SSH port forward exited with code ${termination.code}.`;

      throw new SshPortForwardExecutionError(`${reason}${guidanceSentence}`, {
        ...getErrorDetails({
          exitCode: termination.code,
          signal: termination.signal,
        }),
      });
    },
  };
}
