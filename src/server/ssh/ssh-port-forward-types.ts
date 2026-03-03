import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import type { SshTargetConnection } from "./ssh-exec.ts";
import type {
  ProcessTimerControls,
  SubprocessTermination,
} from "./ssh-process-utils.ts";

export interface SshPortForwardErrorDetails {
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

export interface SshPortForwardDependencies extends ProcessTimerControls {
  spawnProcess: (
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  now: () => number;
  reserveLocalPort: () => Promise<number>;
  probeForwardReady: (localPort: number) => Promise<boolean>;
}

export interface WaitForForwardReadyRequest {
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
