/**
 * SSH local-port-forward lifecycle helpers.
 *
 * This module validates startup options, manages retry policy for auto-selected
 * local ports, and delegates subprocess lifecycle handling to focused helpers.
 */
import { spawn } from "node:child_process";
import { normalizeRedactions } from "./ssh-process-utils.ts";
import { buildSshPortForwardArgv } from "./ssh-port-forward-argv.ts";
import {
  probeLocalForwardReady,
  reserveLoopbackPort,
} from "./ssh-port-forward-network.ts";
import { startSshPortForwardOnce } from "./ssh-port-forward-process.ts";
import {
  createCancelledBeforeStartError,
  isRetryableAutoLocalPortFailure,
  reserveLocalPortWithErrors,
} from "./ssh-port-forward-startup.ts";
import type {
  SshPortForwardDependencies,
  SshPortForwardHandle,
  SshPortForwardRequest,
} from "./ssh-port-forward-types.ts";
import {
  SshPortForwardExecutionError,
  SshPortForwardValidationError,
} from "./ssh-port-forward-types.ts";

const DEFAULT_MAX_BUFFERED_CHARS = 64 * 1024;
const DEFAULT_DIAGNOSTIC_EXCERPT_CHARS = 4 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const AUTO_LOCAL_PORT_ATTEMPTS = 3;

export {
  buildSshPortForwardArgv,
  SshPortForwardExecutionError,
  SshPortForwardValidationError,
};
export type { SshPortForwardHandle, SshPortForwardRequest };

export async function startSshPortForward(
  input: SshPortForwardRequest,
  overrides: Partial<SshPortForwardDependencies> = {},
): Promise<SshPortForwardHandle> {
  if (input.abortSignal?.aborted) {
    throw createCancelledBeforeStartError(input.remotePort);
  }

  const dependencies: SshPortForwardDependencies = {
    spawnProcess: overrides.spawnProcess ?? spawn,
    setTimer: overrides.setTimer ?? setTimeout,
    clearTimer: overrides.clearTimer ?? clearTimeout,
    now: overrides.now ?? Date.now,
    reserveLocalPort: overrides.reserveLocalPort ?? reserveLoopbackPort,
    probeForwardReady: overrides.probeForwardReady ?? probeLocalForwardReady,
  };

  const maxBufferedChars = input.maxBufferedChars ?? DEFAULT_MAX_BUFFERED_CHARS;
  if (maxBufferedChars <= 0) {
    throw new SshPortForwardValidationError(
      "maxBufferedChars must be greater than zero.",
    );
  }

  const diagnosticExcerptChars =
    input.diagnosticExcerptChars ?? DEFAULT_DIAGNOSTIC_EXCERPT_CHARS;
  if (diagnosticExcerptChars <= 0) {
    throw new SshPortForwardValidationError(
      "diagnosticExcerptChars must be greater than zero.",
    );
  }

  const startupTimeoutMs = input.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  if (startupTimeoutMs <= 0) {
    throw new SshPortForwardValidationError(
      "startupTimeoutMs must be greater than zero.",
    );
  }

  const redactions = normalizeRedactions(input.redactions);
  const maxAttempts = input.localPort !== undefined ? 1 : AUTO_LOCAL_PORT_ATTEMPTS;

  let lastError: SshPortForwardExecutionError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (input.abortSignal?.aborted) {
      throw createCancelledBeforeStartError(input.remotePort);
    }

    const localPort =
      input.localPort ?? (await reserveLocalPortWithErrors(input.remotePort, dependencies));

    try {
      return await startSshPortForwardOnce({
        request: input,
        dependencies,
        localPort,
        startupTimeoutMs,
        maxBufferedChars,
        diagnosticExcerptChars,
        redactions,
      });
    } catch (error) {
      if (!(error instanceof SshPortForwardExecutionError)) {
        throw error;
      }

      lastError = error;
      const canRetry =
        input.localPort === undefined &&
        attempt < maxAttempts &&
        isRetryableAutoLocalPortFailure(error);
      if (!canRetry) {
        throw error;
      }
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new SshPortForwardExecutionError("SSH port forward failed to start.", {
    argv: [],
    remotePort: input.remotePort,
    stdoutExcerpt: "",
    stderrExcerpt: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
}
