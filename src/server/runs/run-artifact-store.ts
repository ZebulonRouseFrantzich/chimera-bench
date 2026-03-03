/**
 * Persistent run artifact storage for terminal run results.
 *
 * Writes are atomic (temp file + rename), reads are path-confined, and failure
 * reasons are tracked per run for operational diagnostics.
 */
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

const RESULT_FILENAME = "result.json";
const MAX_WRITE_FAILURES = 1000;

export const DEFAULT_RUN_ARTIFACTS_ROOT_DIR = "runs";

export class RunArtifactWriteError extends Error {
  readonly logReason: string;

  constructor(message: string, logReason: string = message) {
    super(message);
    this.name = "RunArtifactWriteError";
    this.logReason = logReason;
  }
}

export class RunArtifactReadError extends Error {
  readonly logReason: string;

  constructor(message: string, logReason: string = message) {
    super(message);
    this.name = "RunArtifactReadError";
    this.logReason = logReason;
  }
}

export class RunArtifactStore {
  private readonly rootDir: string;
  private readonly writeFailures = new Map<string, string>();

  constructor(rootDir: string = DEFAULT_RUN_ARTIFACTS_ROOT_DIR) {
    this.rootDir = resolve(rootDir);
  }

  getResultPath(runId: string): string {
    return join(this.rootDir, runId, RESULT_FILENAME);
  }

  getWriteFailure(runId: string): string | undefined {
    return this.writeFailures.get(runId);
  }

  async writeResult(runId: string, result: Record<string, unknown>): Promise<void> {
    const resultPath = this.resolveResultPath(runId, "write");
    const runDir = dirname(resultPath);
    const tempPath = `${resultPath}.tmp-${randomUUID()}`;

    try {
      await mkdir(runDir, {
        recursive: true,
      });
      await writeFile(tempPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      await rename(tempPath, resultPath);
      this.writeFailures.delete(runId);
    } catch (error) {
      const writeError = buildWriteError(runId, resultPath, error);
      this.setWriteFailure(runId, writeError.message);

      try {
        await unlink(tempPath);
      } catch {
        // Best effort cleanup for failed atomic writes.
      }

      throw writeError;
    }
  }

  async readResult(runId: string): Promise<Record<string, unknown> | null> {
    const resultPath = this.resolveResultPath(runId, "read");

    let serializedResult: string;
    try {
      serializedResult = await readFile(resultPath, "utf8");
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        return null;
      }

      throw buildReadError("read", runId, resultPath, error);
    }

    let parsedResult: unknown;
    try {
      parsedResult = JSON.parse(serializedResult);
    } catch (error) {
      throw buildReadError("parse", runId, resultPath, error);
    }

    if (!isRecord(parsedResult)) {
      throw new RunArtifactReadError(
        `Failed to parse run artifact for run '${runId}'. Expected a JSON object.`,
        `Run artifact at '${resultPath}' must be a JSON object.`,
      );
    }

    return parsedResult;
  }

  private setWriteFailure(runId: string, message: string): void {
    if (this.writeFailures.has(runId)) {
      this.writeFailures.delete(runId);
    }

    this.writeFailures.set(runId, message);

    while (this.writeFailures.size > MAX_WRITE_FAILURES) {
      const oldestRunId = this.writeFailures.keys().next().value;
      if (!oldestRunId) {
        break;
      }

      this.writeFailures.delete(oldestRunId);
    }
  }

  private resolveResultPath(runId: string, operation: "read" | "write"): string {
    const resultPath = resolve(this.rootDir, runId, RESULT_FILENAME);

    if (!isPathWithinRoot(resultPath, this.rootDir)) {
      const message = `Invalid runId '${runId}' is outside artifact root.`;
      const logReason =
        `Invalid runId '${runId}' would escape artifact root '${this.rootDir}'.`;
      if (operation === "read") {
        throw new RunArtifactReadError(message, logReason);
      }

      throw new RunArtifactWriteError(message, logReason);
    }

    return resultPath;
  }
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeError = error as {
    code?: unknown;
  };

  return maybeError.code === code;
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  return new Error(`Unexpected non-error value: ${String(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildWriteError(
  runId: string,
  resultPath: string,
  error: unknown,
): RunArtifactWriteError {
  const code = getNodeErrorCode(error);
  const clientReason =
    code !== null
      ? `Failed to persist run artifact for run '${runId}'. Filesystem error (${code}).`
      : `Failed to persist run artifact for run '${runId}'.`;

  return new RunArtifactWriteError(
    clientReason,
    `Failed to persist run artifact at '${resultPath}': ${toError(error).message}`,
  );
}

function buildReadError(
  mode: "read" | "parse",
  runId: string,
  resultPath: string,
  error: unknown,
): RunArtifactReadError {
  if (mode === "parse") {
    return new RunArtifactReadError(
      `Failed to parse run artifact for run '${runId}'. Invalid JSON payload.`,
      `Failed to parse run artifact at '${resultPath}': ${toError(error).message}`,
    );
  }

  const code = getNodeErrorCode(error);
  const clientReason =
    code !== null
      ? `Failed to read run artifact for run '${runId}'. Filesystem error (${code}).`
      : `Failed to read run artifact for run '${runId}'.`;

  return new RunArtifactReadError(
    clientReason,
    `Failed to read run artifact at '${resultPath}': ${toError(error).message}`,
  );
}

function getNodeErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const maybeError = error as {
    code?: unknown;
  };

  return typeof maybeError.code === "string" ? maybeError.code : null;
}

function isPathWithinRoot(path: string, rootDir: string): boolean {
  if (path === rootDir) {
    return true;
  }

  const normalizedRootWithSeparator =
    rootDir.endsWith(sep) ? rootDir : `${rootDir}${sep}`;
  return path.startsWith(normalizedRootWithSeparator);
}
