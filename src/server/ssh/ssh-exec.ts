import { spawn } from "node:child_process";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import type { Readable } from "node:stream";
import { toError } from "../error-utils.ts";
import type { TargetProfile } from "../targets/target-profile.ts";
import {
  buildPosixShellCommand,
  PosixShellQuoteError,
} from "./posix-shell.ts";

const REDACTED_VALUE = "[REDACTED]";
const DEFAULT_MAX_BUFFERED_CHARS = 64 * 1024;
const DEFAULT_DIAGNOSTIC_EXCERPT_CHARS = 4 * 1024;
const DEFAULT_OVERALL_TIMEOUT_MS = 10 * 60 * 1000;
const CANCEL_KILL_GRACE_PERIOD_MS = 500;
const SSH_USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const HOSTNAME_LABEL_PATTERN = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;

const SSH_DEFAULT_OPTIONS: readonly string[] = [
  "BatchMode=yes",
  "StrictHostKeyChecking=yes",
  "ForwardAgent=no",
  "ConnectTimeout=10",
  "ServerAliveInterval=10",
  "ServerAliveCountMax=3",
];

interface SshTerminationExit {
  kind: "exit";
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface SshTerminationError {
  kind: "error";
  error: Error;
}

type SshTermination = SshTerminationExit | SshTerminationError;

export interface SshTargetConnection {
  host: TargetProfile["host"];
  port: TargetProfile["port"];
  username: TargetProfile["username"];
  auth: TargetProfile["auth"];
}

export interface SshCommandRequest {
  profile: SshTargetConnection;
  remoteArgv: readonly string[];
  overallTimeoutMs?: number;
  abortSignal?: AbortSignal;
  maxBufferedChars?: number;
  diagnosticExcerptChars?: number;
  redactions?: readonly string[];
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
}

export interface SshCommandSuccess {
  argv: string[];
  stdoutExcerpt: string;
  stderrExcerpt: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

interface SshExecutionDependencies {
  spawnProcess: (
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
}

interface SshErrorDetails {
  readonly argv: string[];
  readonly stdoutExcerpt: string;
  readonly stderrExcerpt: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
}

export class SshCommandValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshCommandValidationError";
  }
}

export class SshCommandExecutionError extends Error {
  readonly details: SshErrorDetails;

  constructor(message: string, details: SshErrorDetails) {
    super(message);
    this.name = "SshCommandExecutionError";
    this.details = details;
  }
}

export function buildSshCommandArgv(input: {
  profile: SshTargetConnection;
  remoteArgv: readonly string[];
}): string[] {
  const remoteCommand = buildSafeRemoteCommand(input.remoteArgv);
  const destination = buildDestination(input.profile);
  const argv = ["ssh"];

  for (const option of SSH_DEFAULT_OPTIONS) {
    argv.push("-o", option);
  }

  if (input.profile.auth.method === "key-path") {
    argv.push("-i", input.profile.auth.privateKeyPath);
  }

  argv.push("-p", String(input.profile.port));
  argv.push(destination, remoteCommand);

  return argv;
}

export async function executeSshCommand(
  input: SshCommandRequest,
  overrides: Partial<SshExecutionDependencies> = {},
): Promise<SshCommandSuccess> {
  if (input.abortSignal?.aborted) {
    throw new SshCommandExecutionError("SSH command cancelled before start.", {
      argv: [],
      stdoutExcerpt: "",
      stderrExcerpt: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  }

  const dependencies: SshExecutionDependencies = {
    spawnProcess: overrides.spawnProcess ?? spawn,
    setTimer: overrides.setTimer ?? setTimeout,
    clearTimer: overrides.clearTimer ?? clearTimeout,
  };

  const argv = buildSshCommandArgv({
    profile: input.profile,
    remoteArgv: input.remoteArgv,
  });
  const [command, ...args] = argv;
  if (!command) {
    throw new SshCommandValidationError("SSH command argv cannot be empty.");
  }

  const maxBufferedChars = input.maxBufferedChars ?? DEFAULT_MAX_BUFFERED_CHARS;
  const diagnosticExcerptChars =
    input.diagnosticExcerptChars ?? DEFAULT_DIAGNOSTIC_EXCERPT_CHARS;
  const overallTimeoutMs = input.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
  if (maxBufferedChars <= 0) {
    throw new SshCommandValidationError("maxBufferedChars must be greater than zero.");
  }

  if (diagnosticExcerptChars <= 0) {
    throw new SshCommandValidationError(
      "diagnosticExcerptChars must be greater than zero.",
    );
  }

  if (overallTimeoutMs <= 0) {
    throw new SshCommandValidationError(
      "overallTimeoutMs must be greater than zero.",
    );
  }

  const redactions = normalizeRedactions(input.redactions);

  let subprocess: ChildProcessWithoutNullStreams;
  try {
    subprocess = dependencies.spawnProcess(command, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new SshCommandExecutionError(
      `Failed to start ssh process: ${toError(error).message}`,
      {
        argv: redactArray(argv, redactions),
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

  const stdoutBuffer = new RollingTextBuffer(maxBufferedChars);
  const stderrBuffer = new RollingTextBuffer(maxBufferedChars);

  attachOutput(subprocess.stdout, stdoutBuffer, redactions, input.onStdoutChunk);
  attachOutput(subprocess.stderr, stderrBuffer, redactions, input.onStderrChunk);

  let timedOut = false;
  let cancelled = false;

  const terminationPromise = createTerminationPromise(subprocess);

  const timeoutHandle = dependencies.setTimer(() => {
    timedOut = true;
    cancelSubprocess(subprocess, dependencies);
  }, overallTimeoutMs);

  const onAbort = () => {
    cancelled = true;
    cancelSubprocess(subprocess, dependencies);
  };
  input.abortSignal?.addEventListener("abort", onAbort, {
    once: true,
  });

  try {
    const termination = await terminationPromise;
    const stdoutExcerpt = stdoutBuffer.excerpt(diagnosticExcerptChars);
    const stderrExcerpt = stderrBuffer.excerpt(diagnosticExcerptChars);
    const stdoutTruncated = stdoutBuffer.wasTruncated();
    const stderrTruncated = stderrBuffer.wasTruncated();
    const redactedArgv = redactArray(argv, redactions);

    if (timedOut) {
      throw new SshCommandExecutionError(
        `SSH command timed out after ${overallTimeoutMs}ms.`,
        {
          argv: redactedArgv,
          stdoutExcerpt,
          stderrExcerpt,
          stdoutTruncated,
          stderrTruncated,
        },
      );
    }

    if (cancelled) {
      throw new SshCommandExecutionError("SSH command was cancelled.", {
        argv: redactedArgv,
        stdoutExcerpt,
        stderrExcerpt,
        stdoutTruncated,
        stderrTruncated,
      });
    }

    if (termination.kind === "error") {
      throw new SshCommandExecutionError(
        `SSH process failed: ${redactText(termination.error.message, redactions)}.`,
        {
          argv: redactedArgv,
          stdoutExcerpt,
          stderrExcerpt,
          stdoutTruncated,
          stderrTruncated,
        },
      );
    }

    if (termination.code !== 0) {
      const guidance = classifySshFailureGuidance(stderrExcerpt);
      const guidanceSentence = guidance ? ` ${guidance}` : "";
      const reason =
        termination.code === null
          ? `SSH command terminated by signal ${termination.signal ?? "unknown"}.`
          : `SSH command exited with code ${termination.code}.`;

      throw new SshCommandExecutionError(`${reason}${guidanceSentence}`, {
        argv: redactedArgv,
        stdoutExcerpt,
        stderrExcerpt,
        stdoutTruncated,
        stderrTruncated,
        exitCode: termination.code,
        signal: termination.signal,
      });
    }

    return {
      argv: redactedArgv,
      stdoutExcerpt,
      stderrExcerpt,
      stdoutTruncated,
      stderrTruncated,
    };
  } finally {
    dependencies.clearTimer(timeoutHandle);
    input.abortSignal?.removeEventListener("abort", onAbort);
  }
}

export function classifySshFailureGuidance(stderrText: string): string | null {
  const normalized = stderrText.toLowerCase();

  if (
    normalized.includes("agent has no identities") ||
    normalized.includes("the agent has no identities") ||
    normalized.includes("no identities")
  ) {
    return (
      "ssh-agent has no identities loaded. Run `ssh-add` (or switch the profile to key-path auth) and retry."
    );
  }

  if (
    normalized.includes("host key verification failed") ||
    normalized.includes("remote host identification has changed")
  ) {
    return (
      "SSH host key verification failed. Verify the remote host key in ~/.ssh/known_hosts and retry."
    );
  }

  if (normalized.includes("permission denied")) {
    return (
      "SSH authentication failed. Verify the profile username and credentials (ssh-agent or key-path) and retry."
    );
  }

  return null;
}

function buildDestination(profile: SshTargetConnection): string {
  if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) {
    throw new SshCommandValidationError("SSH profile port must be an integer between 1 and 65535.");
  }

  validateConnectionField("host", profile.host);
  if (!isValidSshHost(profile.host)) {
    throw new SshCommandValidationError(
      "host must be a valid hostname or IP address.",
    );
  }

  validateConnectionField("username", profile.username);
  if (!SSH_USERNAME_PATTERN.test(profile.username)) {
    throw new SshCommandValidationError(
      "username must contain only ASCII letters, digits, dots, underscores, or hyphens.",
    );
  }

  if (profile.auth.method === "key-path") {
    validateConnectionField("auth.privateKeyPath", profile.auth.privateKeyPath);
    if (!isAbsolute(profile.auth.privateKeyPath)) {
      throw new SshCommandValidationError("auth.privateKeyPath must be absolute.");
    }
  }

  return `${profile.username}@${profile.host}`;
}

function validateConnectionField(fieldName: string, value: string): void {
  if (value.includes("\u0000")) {
    throw new SshCommandValidationError(`${fieldName} must not contain NUL bytes.`);
  }

  if (value.trim().length === 0) {
    throw new SshCommandValidationError(`${fieldName} must not be empty.`);
  }
}

function buildSafeRemoteCommand(remoteArgv: readonly string[]): string {
  try {
    return buildPosixShellCommand(remoteArgv);
  } catch (error) {
    if (error instanceof PosixShellQuoteError) {
      throw new SshCommandValidationError(error.message);
    }

    throw error;
  }
}

function attachOutput(
  stream: Readable | null,
  outputBuffer: RollingTextBuffer,
  redactions: readonly string[],
  onChunk?: (chunk: string) => void,
): void {
  if (!stream) {
    return;
  }

  stream.setEncoding("utf8");
  stream.on("data", (chunk: string | Buffer) => {
    const normalizedChunk =
      typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const redactedChunk = redactText(normalizedChunk, redactions);
    outputBuffer.append(redactedChunk);
    onChunk?.(redactedChunk);
  });
}

function createTerminationPromise(
  subprocess: ChildProcessWithoutNullStreams,
): Promise<SshTermination> {
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
      subprocess.off("close", onExit);
    };

    subprocess.once("error", onError);
    subprocess.once("close", onExit);
  });
}

function cancelSubprocess(
  subprocess: ChildProcessWithoutNullStreams,
  dependencies: SshExecutionDependencies,
): void {
  try {
    subprocess.kill("SIGTERM");
  } catch {
    return;
  }

  const killTimer = dependencies.setTimer(() => {
    try {
      subprocess.kill("SIGKILL");
    } catch {
      // Best effort escalation if ssh ignores SIGTERM.
    }
  }, CANCEL_KILL_GRACE_PERIOD_MS);

  const clearKillTimer = () => {
    dependencies.clearTimer(killTimer);
    subprocess.off("close", clearKillTimer);
    subprocess.off("error", clearKillTimer);
  };

  subprocess.once("close", clearKillTimer);
  subprocess.once("error", clearKillTimer);
}

function normalizeRedactions(redactions: readonly string[] | undefined): string[] {
  if (!redactions || redactions.length === 0) {
    return [];
  }

  return Array.from(
    new Set(
      redactions
        .filter((candidate) => candidate.length > 0)
        .sort((left, right) => right.length - left.length),
    ),
  );
}

function redactArray(values: readonly string[], redactions: readonly string[]): string[] {
  return values.map((value) => redactText(value, redactions));
}

function redactText(value: string, redactions: readonly string[]): string {
  if (redactions.length === 0 || value.length === 0) {
    return value;
  }

  let redacted = value;
  for (const secret of redactions) {
    redacted = redacted.split(secret).join(REDACTED_VALUE);
  }

  return redacted;
}

class RollingTextBuffer {
  private value = "";
  private truncated = false;

  constructor(private readonly maxChars: number) {}

  append(chunk: string): void {
    if (chunk.length === 0) {
      return;
    }

    const normalizedChunk =
      chunk.length > this.maxChars ? chunk.slice(-this.maxChars) : chunk;
    if (normalizedChunk.length !== chunk.length) {
      this.truncated = true;
    }

    this.value += normalizedChunk;
    if (this.value.length > this.maxChars) {
      this.truncated = true;
      this.value = this.value.slice(-this.maxChars);
    }
  }

  excerpt(maxChars: number): string {
    if (this.value.length <= maxChars) {
      return this.value.trim();
    }

    return this.value.slice(-maxChars).trim();
  }

  wasTruncated(): boolean {
    return this.truncated;
  }
}

function isValidSshHost(value: string): boolean {
  if (isIP(value) !== 0) {
    return true;
  }

  if (value.includes("..") || value.endsWith(".")) {
    return false;
  }

  const labels = value.split(".");
  if (labels.length === 0) {
    return false;
  }

  return labels.every((label) => HOSTNAME_LABEL_PATTERN.test(label));
}
