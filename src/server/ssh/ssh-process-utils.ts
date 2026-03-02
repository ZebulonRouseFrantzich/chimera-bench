import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";

const DEFAULT_REDACTED_VALUE = "[REDACTED]";

export interface SubprocessTerminationExit {
  kind: "exit";
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface SubprocessTerminationError {
  kind: "error";
  error: Error;
}

export type SubprocessTermination =
  | SubprocessTerminationExit
  | SubprocessTerminationError;

export interface ProcessTimerControls {
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
}

export class RollingTextBuffer {
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

export function normalizeRedactions(
  redactions: readonly string[] | undefined,
): string[] {
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

export function redactArray(
  values: readonly string[],
  redactions: readonly string[],
  replacement: string = DEFAULT_REDACTED_VALUE,
): string[] {
  return values.map((value) => redactText(value, redactions, replacement));
}

export function redactText(
  value: string,
  redactions: readonly string[],
  replacement: string = DEFAULT_REDACTED_VALUE,
): string {
  if (redactions.length === 0 || value.length === 0) {
    return value;
  }

  let redacted = value;
  for (const secret of redactions) {
    redacted = redacted.split(secret).join(replacement);
  }

  return redacted;
}

export function attachOutputStream(input: {
  stream: Readable | null;
  outputBuffer: RollingTextBuffer;
  redactions: readonly string[];
  onChunk?: (chunk: string) => void;
  replacement?: string;
}): void {
  if (!input.stream) {
    return;
  }

  const replacement = input.replacement ?? DEFAULT_REDACTED_VALUE;
  input.stream.setEncoding("utf8");
  input.stream.on("data", (chunk: string | Buffer) => {
    const normalizedChunk =
      typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const redactedChunk = redactText(normalizedChunk, input.redactions, replacement);
    input.outputBuffer.append(redactedChunk);
    input.onChunk?.(redactedChunk);
  });
}

export function createTerminationPromise(
  subprocess: ChildProcessWithoutNullStreams,
): Promise<SubprocessTermination> {
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

export function cancelSubprocess(
  subprocess: ChildProcessWithoutNullStreams,
  input: ProcessTimerControls & {
    killGracePeriodMs: number;
  },
): void {
  try {
    subprocess.kill("SIGTERM");
  } catch {
    return;
  }

  const killTimer = input.setTimer(() => {
    try {
      subprocess.kill("SIGKILL");
    } catch {
      // Best effort escalation if the subprocess ignores SIGTERM.
    }
  }, input.killGracePeriodMs);

  const clearKillTimer = () => {
    input.clearTimer(killTimer);
    subprocess.off("close", clearKillTimer);
    subprocess.off("error", clearKillTimer);
  };

  subprocess.once("close", clearKillTimer);
  subprocess.once("error", clearKillTimer);
}
