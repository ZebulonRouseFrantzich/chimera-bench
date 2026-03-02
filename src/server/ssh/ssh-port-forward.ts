import { spawn } from "node:child_process";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { createServer, Socket } from "node:net";
import type { Server } from "node:net";
import { toError } from "../error-utils.ts";
import {
  buildSshBaseConnectionParts,
  classifySshFailureGuidance,
  type SshTargetConnection,
} from "./ssh-exec.ts";
import {
  attachOutputStream,
  cancelSubprocess,
  createTerminationPromise,
  normalizeRedactions,
  redactArray,
  redactText,
  RollingTextBuffer,
  type ProcessTimerControls,
  type SubprocessTermination,
} from "./ssh-process-utils.ts";

const DEFAULT_MAX_BUFFERED_CHARS = 64 * 1024;
const DEFAULT_DIAGNOSTIC_EXCERPT_CHARS = 4 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const STARTUP_POLL_INTERVAL_MS = 75;
const PROBE_CONNECT_TIMEOUT_MS = 250;
const PROBE_STABILITY_WINDOW_MS = 150;
const CANCEL_KILL_GRACE_PERIOD_MS = 500;
const AUTO_LOCAL_PORT_ATTEMPTS = 3;
const RETRYABLE_LOCAL_FORWARD_FAILURE_PATTERN =
  /address already in use|cannot assign requested address|could not request local forwarding/i;
const REMOTE_LOOPBACK_CONNECT_FAILURE_PATTERN =
  /open failed: connect failed|connection refused|connect failed/i;

interface SshPortForwardDependencies extends ProcessTimerControls {
  spawnProcess: (
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  now: () => number;
  reserveLocalPort: () => Promise<number>;
  probeForwardReady: (localPort: number) => Promise<boolean>;
}

interface WaitForForwardReadyRequest {
  localPort: number;
  startupTimeoutMs: number;
  pollIntervalMs: number;
  abortSignal?: AbortSignal;
  terminationPromise: Promise<SubprocessTermination>;
  probeForwardReady: (localPort: number) => Promise<boolean>;
  hasRemoteConnectionFailure: () => boolean;
  now: () => number;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
}

interface SshPortForwardErrorDetails {
  readonly argv: string[];
  readonly localPort?: number;
  readonly remotePort: number;
  readonly stdoutExcerpt: string;
  readonly stderrExcerpt: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
}

export interface SshPortForwardRequest {
  readonly profile: SshTargetConnection;
  readonly remotePort: number;
  readonly localPort?: number;
  readonly startupTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly maxBufferedChars?: number;
  readonly diagnosticExcerptChars?: number;
  readonly redactions?: readonly string[];
  readonly onStdoutChunk?: (chunk: string) => void;
  readonly onStderrChunk?: (chunk: string) => void;
}

export interface SshPortForwardHandle {
  readonly localPort: number;
  readonly argv: string[];
  waitForExit: () => Promise<void>;
}

export class SshPortForwardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshPortForwardValidationError";
  }
}

export class SshPortForwardExecutionError extends Error {
  readonly details: SshPortForwardErrorDetails;

  constructor(message: string, details: SshPortForwardErrorDetails) {
    super(message);
    this.name = "SshPortForwardExecutionError";
    this.details = details;
  }
}

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

export function buildSshPortForwardArgv(input: {
  profile: SshTargetConnection;
  localPort: number;
  remotePort: number;
}): string[] {
  assertPortInRange(input.localPort, "localPort");
  assertPortInRange(input.remotePort, "remotePort");

  const connection = buildSshBaseConnectionParts(input.profile);

  return [
    connection.command,
    ...connection.optionsArgv,
    "-o",
    "ExitOnForwardFailure=yes",
    "-N",
    "-L",
    `127.0.0.1:${input.localPort}:127.0.0.1:${input.remotePort}`,
    connection.destination,
  ];
}

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
        input,
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

async function startSshPortForwardOnce(input: {
  input: SshPortForwardRequest;
  dependencies: SshPortForwardDependencies;
  localPort: number;
  startupTimeoutMs: number;
  maxBufferedChars: number;
  diagnosticExcerptChars: number;
  redactions: readonly string[];
}): Promise<SshPortForwardHandle> {
  const argv = buildSshPortForwardArgv({
    profile: input.input.profile,
    localPort: input.localPort,
    remotePort: input.input.remotePort,
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
        remotePort: input.input.remotePort,
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
    ...(input.input.onStdoutChunk
      ? {
          onChunk: input.input.onStdoutChunk,
        }
      : {}),
  });
  attachOutputStream({
    stream: subprocess.stderr,
    outputBuffer: stderrBuffer,
    redactions: input.redactions,
    ...(input.input.onStderrChunk
      ? {
          onChunk: input.input.onStderrChunk,
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

  input.input.abortSignal?.addEventListener("abort", onAbort, {
    once: true,
  });
  void terminationPromise.then((termination) => {
    observedTermination = termination;
    input.input.abortSignal?.removeEventListener("abort", onAbort);
  });

  const getErrorDetails = (
    termination?: {
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
    },
  ): SshPortForwardErrorDetails => ({
    argv: redactArray(argv, input.redactions),
    localPort: input.localPort,
    remotePort: input.input.remotePort,
    stdoutExcerpt: stdoutBuffer.excerpt(input.diagnosticExcerptChars),
    stderrExcerpt: stderrBuffer.excerpt(input.diagnosticExcerptChars),
    stdoutTruncated: stdoutBuffer.wasTruncated(),
    stderrTruncated: stderrBuffer.wasTruncated(),
    ...(termination ? termination : {}),
  });

  const hasRemoteConnectionFailure = (): boolean => {
    const stderrExcerpt = stderrBuffer.excerpt(input.diagnosticExcerptChars);
    return REMOTE_LOOPBACK_CONNECT_FAILURE_PATTERN.test(stderrExcerpt);
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
      ...(input.input.abortSignal
        ? {
            abortSignal: input.input.abortSignal,
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
    throw buildStartupError(
      error,
      termination,
      getErrorDetails,
      input.startupTimeoutMs,
      input.input.remotePort,
      input.redactions,
    );
  }

  if (observedTermination !== null) {
    throw buildStartupError(
      new SshPortForwardStartupError("terminated"),
      observedTermination,
      getErrorDetails,
      input.startupTimeoutMs,
      input.input.remotePort,
      input.redactions,
    );
  }

  return {
    localPort: input.localPort,
    argv: redactArray(argv, input.redactions),
    waitForExit: async (): Promise<void> => {
      const termination = await terminationPromise;

      if (cancelled) {
        throw new SshPortForwardExecutionError(
          "SSH port forward was cancelled.",
          getErrorDetails({
            ...(termination.kind === "exit"
              ? {
                  exitCode: termination.code,
                  signal: termination.signal,
                }
              : {}),
          }),
        );
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

function createCancelledBeforeStartError(
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

async function reserveLocalPortWithErrors(
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

function isRetryableAutoLocalPortFailure(
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

function buildStartupError(
  error: unknown,
  termination: SubprocessTermination,
  getErrorDetails: (termination?: {
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
  }) => SshPortForwardErrorDetails,
  startupTimeoutMs: number,
  remotePort: number,
  redactions: readonly string[],
): SshPortForwardExecutionError {
  if (error instanceof SshPortForwardStartupError) {
    if (error.reason === "cancelled") {
      return new SshPortForwardExecutionError(
        "SSH port forward was cancelled before startup completed.",
        getErrorDetails(),
      );
    }

    if (error.reason === "timeout") {
      return new SshPortForwardExecutionError(
        `SSH port forward did not become ready within ${startupTimeoutMs}ms.`,
        getErrorDetails(),
      );
    }

    if (error.reason === "remote-unreachable") {
      return new SshPortForwardExecutionError(
        `SSH port forward could not connect to remote 127.0.0.1:${remotePort}. Ensure the remote service is listening on loopback and retry.`,
        getErrorDetails(),
      );
    }
  }

  if (termination.kind === "error") {
    return new SshPortForwardExecutionError(
      `SSH port forward process failed: ${redactText(termination.error.message, redactions)}.`,
      getErrorDetails(),
    );
  }

  const details = getErrorDetails({
    exitCode: termination.code,
    signal: termination.signal,
  });
  const guidance = classifySshFailureGuidance(details.stderrExcerpt);
  const guidanceSentence = guidance ? ` ${guidance}` : "";
  const reason =
    termination.code === null
      ? `SSH port forward terminated by signal ${termination.signal ?? "unknown"} during startup.`
      : `SSH port forward exited with code ${termination.code} during startup.`;

  return new SshPortForwardExecutionError(`${reason}${guidanceSentence}`, details);
}

async function waitForForwardReady(input: WaitForForwardReadyRequest): Promise<void> {
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

    const waitOutcome = await Promise.race([
      delayMs(input.pollIntervalMs, input.setTimer).then(() => ({
        kind: "continue" as const,
      })),
      input.terminationPromise.then((termination) => ({
        kind: "terminated" as const,
        termination,
      })),
    ]);

    if (waitOutcome.kind === "terminated") {
      throw new SshPortForwardStartupError("terminated");
    }
  }
}

function assertPortInRange(port: number, fieldName: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SshPortForwardValidationError(
      `${fieldName} must be an integer between 1 and 65535.`,
    );
  }
}

function delayMs(durationMs: number, setTimer: typeof setTimeout): Promise<void> {
  return new Promise((resolve) => {
    setTimer(() => {
      resolve();
    }, durationMs);
  });
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();

  try {
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
      server.listen(0, "127.0.0.1");
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to determine local port for SSH forwarding.");
    }

    return address.port;
  } finally {
    await closeServer(server);
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    try {
      server.close((error) => {
        if (!error) {
          resolve();
          return;
        }

        const errorCode = (error as NodeJS.ErrnoException).code;
        if (errorCode === "ERR_SERVER_NOT_RUNNING") {
          resolve();
          return;
        }

        reject(error);
      });
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode === "ERR_SERVER_NOT_RUNNING") {
        resolve();
        return;
      }

      reject(error);
    }
  });
}

async function probeLocalForwardReady(localPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    let stabilityTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (ready: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      if (stabilityTimer !== null) {
        clearTimeout(stabilityTimer);
      }
      cleanup();
      socket.destroy();
      resolve(ready);
    };

    const onFailure = () => {
      finish(false);
    };

    const onConnect = () => {
      stabilityTimer = setTimeout(() => {
        finish(true);
      }, PROBE_STABILITY_WINDOW_MS);
    };

    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onFailure);
      socket.off("timeout", onFailure);
      socket.off("close", onFailure);
    };

    socket.setTimeout(PROBE_CONNECT_TIMEOUT_MS);
    socket.once("connect", onConnect);
    socket.once("error", onFailure);
    socket.once("timeout", onFailure);
    socket.once("close", onFailure);
    socket.connect({
      host: "127.0.0.1",
      port: localPort,
    });
  });
}
