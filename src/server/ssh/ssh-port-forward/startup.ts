/**
 * SSH port-forward startup state and retry helpers.
 *
 * This module classifies startup failures, performs readiness polling against
 * process lifecycle events, and maps failures into stable execution errors.
 */
import { toError } from "../../error-utils.ts";
import { classifySshFailureGuidance } from "../ssh-exec.ts";
import { redactText, type SubprocessTermination } from "../ssh-process-utils.ts";
import type {
  SshPortForwardDependencies,
  SshPortForwardErrorDetails,
  WaitForForwardReadyRequest,
} from "./types.ts";
import { SshPortForwardExecutionError } from "./types.ts";

const RETRYABLE_LOCAL_FORWARD_FAILURE_PATTERN =
  /address already in use|cannot assign requested address|could not request local forwarding/i;
const REMOTE_LOOPBACK_CONNECT_FAILURE_PATTERN =
  /open failed: connect failed|connection refused|connect failed/i;

class SshPortForwardStartupError extends Error {
  readonly reason:
    | "cancelled"
    | "timeout"
    | "terminated"
    | "remote-unreachable";

  constructor(
    reason:
      | "cancelled"
      | "timeout"
      | "terminated"
      | "remote-unreachable",
  ) {
    super(`SSH port-forward startup failed: ${reason}.`);
    this.name = "SshPortForwardStartupError";
    this.reason = reason;
  }
}

export function createCancelledBeforeStartError(
  remotePort: number,
): SshPortForwardExecutionError {
  return new SshPortForwardExecutionError(
    "SSH port forward was cancelled before start.",
    {
      argv: [],
      remotePort,
      stdoutExcerpt: "",
      stderrExcerpt: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    },
  );
}

export async function reserveLocalPortWithErrors(
  remotePort: number,
  dependencies: Pick<SshPortForwardDependencies, "reserveLocalPort">,
): Promise<number> {
  try {
    return await dependencies.reserveLocalPort();
  } catch (error) {
    throw new SshPortForwardExecutionError(
      `Failed to reserve a local port for SSH forwarding: ${toError(error).message}`,
      {
        argv: [],
        remotePort,
        stdoutExcerpt: "",
        stderrExcerpt: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    );
  }
}

export function isRetryableAutoLocalPortFailure(
  error: SshPortForwardExecutionError,
): boolean {
  if (error.message.toLowerCase().includes("cancelled")) {
    return false;
  }

  const normalizedStderr = error.details.stderrExcerpt.toLowerCase();
  if (classifySshFailureGuidance(normalizedStderr)) {
    return false;
  }

  return RETRYABLE_LOCAL_FORWARD_FAILURE_PATTERN.test(normalizedStderr);
}

export function buildStartupError(input: {
  error: unknown;
  termination: SubprocessTermination;
  getErrorDetails: (termination?: {
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
  }) => SshPortForwardErrorDetails;
  startupTimeoutMs: number;
  remotePort: number;
  redactions: readonly string[];
}): SshPortForwardExecutionError {
  if (input.error instanceof SshPortForwardStartupError) {
    if (input.error.reason === "cancelled") {
      return new SshPortForwardExecutionError(
        "SSH port forward was cancelled before startup completed.",
        input.getErrorDetails(),
      );
    }

    if (input.error.reason === "timeout") {
      return new SshPortForwardExecutionError(
        `SSH port forward did not become ready within ${input.startupTimeoutMs}ms.`,
        input.getErrorDetails(),
      );
    }

    if (input.error.reason === "remote-unreachable") {
      return new SshPortForwardExecutionError(
        `SSH port forward could not connect to remote 127.0.0.1:${input.remotePort}. Ensure the remote service is listening on loopback and retry.`,
        input.getErrorDetails(),
      );
    }
  }

  if (input.termination.kind === "error") {
    return new SshPortForwardExecutionError(
      `SSH port forward process failed: ${redactText(input.termination.error.message, input.redactions)}.`,
      input.getErrorDetails(),
    );
  }

  const details = input.getErrorDetails({
    exitCode: input.termination.code,
    signal: input.termination.signal,
  });
  const guidance = classifySshFailureGuidance(details.stderrExcerpt);
  const guidanceSentence = guidance ? ` ${guidance}` : "";
  const reason =
    input.termination.code === null
      ? `SSH port forward terminated by signal ${input.termination.signal ?? "unknown"} during startup.`
      : `SSH port forward exited with code ${input.termination.code} during startup.`;

  return new SshPortForwardExecutionError(`${reason}${guidanceSentence}`, details);
}

export async function waitForForwardReady(
  input: WaitForForwardReadyRequest,
): Promise<void> {
  const startupDeadline = input.now() + input.startupTimeoutMs;

  while (true) {
    if (input.abortSignal?.aborted) {
      throw new SshPortForwardStartupError("cancelled");
    }

    const probeOutcome = await Promise.race([
      input.probeForwardReady(input.localPort).then((ready) => ({
        kind: "probe" as const,
        ready,
      })),
      input.terminationPromise.then((termination) => ({
        kind: "terminated" as const,
        termination,
      })),
    ]);

    if (probeOutcome.kind === "terminated") {
      throw new SshPortForwardStartupError("terminated");
    }

    if (probeOutcome.ready) {
      return;
    }

    if (input.hasRemoteConnectionFailure()) {
      throw new SshPortForwardStartupError("remote-unreachable");
    }

    if (input.now() >= startupDeadline) {
      throw new SshPortForwardStartupError("timeout");
    }

    const waitOutcome = await waitForDelayOrTermination({
      durationMs: input.pollIntervalMs,
      terminationPromise: input.terminationPromise,
      setTimer: input.setTimer,
      clearTimer: input.clearTimer,
    });

    if (waitOutcome.kind === "terminated") {
      throw new SshPortForwardStartupError("terminated");
    }
  }
}

export function hasRemoteLoopbackConnectFailure(stderrExcerpt: string): boolean {
  return REMOTE_LOOPBACK_CONNECT_FAILURE_PATTERN.test(stderrExcerpt);
}

function waitForDelayOrTermination(input: {
  durationMs: number;
  terminationPromise: Promise<SubprocessTermination>;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
}): Promise<
  | {
      kind: "continue";
    }
  | {
      kind: "terminated";
      termination: SubprocessTermination;
    }
> {
  return new Promise((resolve) => {
    let settled = false;
    const delayTimer = input.setTimer(() => {
      if (settled) {
        return;
      }

      settled = true;
      input.clearTimer(delayTimer);
      resolve({
        kind: "continue",
      });
    }, input.durationMs);

    void input.terminationPromise.then((termination) => {
      if (settled) {
        return;
      }

      settled = true;
      input.clearTimer(delayTimer);
      resolve({
        kind: "terminated",
        termination,
      });
    });
  });
}
