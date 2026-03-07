/**
 * Run-time context ingestion and workload provenance snapshotting.
 *
 * Filesystem workload packs can reference local context documents. This module
 * resolves and reads those documents with strict path confinement, injects
 * deterministic context messages, and computes reproducibility digests.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { sanitizeControlCharacters } from "../http/sanitize.ts";
import {
  DEFAULT_SERVER_LOGGER,
  type ServerLogger,
} from "../logging.ts";
import {
  buildPromptText,
  type StarterWorkload,
  type WorkloadMessage,
} from "../runs/starter-workload.ts";
import { stableJsonStringify } from "./canonical-json.ts";
import {
  logContextIngestion,
  logWorkloadDigestComputation,
} from "./context-ingestion-logging.ts";
import { MAX_CONTEXT_FILES_PER_PROMPT } from "./pack-schema.ts";

export const MAX_CONTEXT_FILE_BYTES = 64 * 1024;
export const MAX_COMBINED_CONTEXT_BYTES_PER_PROMPT = 128 * 1024;
export const CONTEXT_TRUNCATION_MARKER = "\n...[truncated]...\n";
const CONTEXT_OMITTED_MARKER_PREFIX = "...[omitted context files due to budget count=";

export interface WorkloadContextDigest {
  path: string;
  sha256: string;
  bytes: number;
  truncated: boolean;
}

export interface WorkloadPackProvenance {
  schemaVersion: number;
  version: string;
  source: "built-in" | "filesystem";
  digestSha256: string;
  contextDigests: readonly WorkloadContextDigest[];
}

export class WorkloadContextIngestionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly logReason: string,
  ) {
    super(message);
    this.name = "WorkloadContextIngestionError";
  }
}

export async function prepareWorkloadForRun(input: {
  workload: StarterWorkload;
  logger?: ServerLogger;
  requestId?: string;
  now?: () => number;
}): Promise<{
  workload: StarterWorkload;
  workloadPack: WorkloadPackProvenance;
}> {
  const logger = input.logger ?? DEFAULT_SERVER_LOGGER;
  const now = input.now ?? Date.now;

  if (!hasContextFiles(input.workload)) {
    const digestStartedAtMs = now();
    const workloadPack = buildWorkloadPackProvenance(input.workload, []);
    logWorkloadDigestComputation({
      logger,
      requestId: input.requestId,
      workload: input.workload,
      contextDigestsCount: 0,
      digestSha256: workloadPack.digestSha256,
      elapsedMs: Math.max(0, now() - digestStartedAtMs),
    });

    return {
      workload: input.workload,
      workloadPack,
    };
  }

  if (!input.workload.packRootDir) {
    throw new WorkloadContextIngestionError(
      "VALIDATION_CONTEXT_ROOT_REQUIRED",
      "Context files require a filesystem workload pack root.",
      "contextFiles were present without a filesystem pack root.",
    );
  }

  const canonicalPackRoot = await resolveCanonicalPackRoot(input.workload.packRootDir);
  const preparedCases: Array<StarterWorkload["cases"][number]> = [];
  const contextDigests: WorkloadContextDigest[] = [];

  for (const workloadCase of input.workload.cases) {
    if (workloadCase.contextFiles.length === 0) {
      preparedCases.push(workloadCase);
      continue;
    }

    const caseStartedAtMs = now();
    const ingestion = await ingestCaseContextFiles({
      packRootDir: canonicalPackRoot,
      contextFiles: workloadCase.contextFiles,
    });

    const injectedMessages: WorkloadMessage[] = [
      {
        role: "system",
        content: ingestion.systemMessage,
      },
      ...workloadCase.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ];

    preparedCases.push({
      ...workloadCase,
      messages: injectedMessages,
      prompt: buildPromptText(injectedMessages),
    });
    contextDigests.push(...ingestion.contextDigests);

    const elapsedMs = Math.max(0, now() - caseStartedAtMs);
    logContextIngestion({
      logger,
      requestId: input.requestId,
      workloadId: input.workload.workloadId,
      caseId: workloadCase.caseId,
      filesRead: ingestion.filesRead,
      contextBytes: ingestion.contextBytes,
      truncatedFiles: ingestion.truncatedFiles,
      omittedFiles: ingestion.omittedFiles,
      elapsedMs,
    });
  }

  const sortedContextDigests = [...contextDigests].sort(compareContextDigestEntries);
  const digestStartedAtMs = now();
  const workloadPack = buildWorkloadPackProvenance(input.workload, sortedContextDigests);
  logWorkloadDigestComputation({
    logger,
    requestId: input.requestId,
    workload: input.workload,
    contextDigestsCount: sortedContextDigests.length,
    digestSha256: workloadPack.digestSha256,
    elapsedMs: Math.max(0, now() - digestStartedAtMs),
  });

  return {
    workload: {
      ...input.workload,
      cases: preparedCases,
    },
    workloadPack,
  };
}

interface IngestCaseContextFilesResult {
  systemMessage: string;
  contextDigests: readonly WorkloadContextDigest[];
  filesRead: number;
  contextBytes: number;
  truncatedFiles: number;
  omittedFiles: number;
}

async function ingestCaseContextFiles(input: {
  packRootDir: string;
  contextFiles: readonly string[];
}): Promise<IngestCaseContextFilesResult> {
  if (input.contextFiles.length > MAX_CONTEXT_FILES_PER_PROMPT) {
    throw new WorkloadContextIngestionError(
      "VALIDATION_CONTEXT_FILES_LIMIT_EXCEEDED",
      `Context file count exceeds ${MAX_CONTEXT_FILES_PER_PROMPT} per prompt.`,
      `contextFiles length ${input.contextFiles.length} exceeded prompt budget ${MAX_CONTEXT_FILES_PER_PROMPT}.`,
    );
  }

  let remainingCombinedBudget = MAX_COMBINED_CONTEXT_BYTES_PER_PROMPT;
  const contextDigests: WorkloadContextDigest[] = [];
  const messageSections: string[] = [];
  let filesRead = 0;
  let contextBytes = 0;
  let truncatedFiles = 0;
  let omittedFiles = 0;

  for (const contextPath of input.contextFiles) {
    if (remainingCombinedBudget <= 0) {
      omittedFiles += 1;
      continue;
    }

    const readBudget = Math.min(MAX_CONTEXT_FILE_BYTES, remainingCombinedBudget);
    const readResult = await readContextFileWithinBudget({
      packRootDir: input.packRootDir,
      relativePath: contextPath,
      byteLimit: readBudget,
    });

    filesRead += 1;
    contextBytes += readResult.sourceBytesUsed;
    remainingCombinedBudget -= readResult.sourceBytesUsed;
    if (readResult.truncated) {
      truncatedFiles += 1;
    }

    messageSections.push(`BEGIN_CONTEXT ${contextPath}`);
    messageSections.push(readResult.injectedText);
    messageSections.push(`END_CONTEXT ${contextPath}`);

    contextDigests.push({
      path: contextPath,
      sha256: createSha256Hex(Buffer.from(readResult.injectedText, "utf8")),
      bytes: Buffer.byteLength(readResult.injectedText, "utf8"),
      truncated: readResult.truncated,
    });
  }

  if (omittedFiles > 0) {
    messageSections.push(`${CONTEXT_OMITTED_MARKER_PREFIX}${omittedFiles}]...`);
  }

  return {
    systemMessage: messageSections.join("\n"),
    contextDigests,
    filesRead,
    contextBytes,
    truncatedFiles,
    omittedFiles,
  };
}

async function resolveCanonicalPackRoot(packRootDir: string): Promise<string> {
  const resolvedRoot = resolve(packRootDir);

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(resolvedRoot);
  } catch (error) {
    throw new WorkloadContextIngestionError(
      "VALIDATION_CONTEXT_ROOT_INVALID",
      "Workload pack root is not accessible.",
      `failed to resolve workload pack root '${resolvedRoot}': ${toErrorMessage(error)}`,
    );
  }

  try {
    const rootStats = await stat(canonicalRoot);
    if (!rootStats.isDirectory()) {
      throw new WorkloadContextIngestionError(
        "VALIDATION_CONTEXT_ROOT_INVALID",
        "Workload pack root is not a directory.",
        `workload pack root '${canonicalRoot}' is not a directory.`,
      );
    }
  } catch (error) {
    if (error instanceof WorkloadContextIngestionError) {
      throw error;
    }

    throw new WorkloadContextIngestionError(
      "VALIDATION_CONTEXT_ROOT_INVALID",
      "Workload pack root is not accessible.",
      `failed to stat workload pack root '${canonicalRoot}': ${toErrorMessage(error)}`,
    );
  }

  return canonicalRoot;
}

async function readContextFileWithinBudget(input: {
  packRootDir: string;
  relativePath: string;
  byteLimit: number;
}): Promise<{
  injectedText: string;
  sourceBytesUsed: number;
  truncated: boolean;
}> {
  if (isAbsolute(input.relativePath)) {
    throw new WorkloadContextIngestionError(
      "VALIDATION_CONTEXT_FILE_ABSOLUTE_PATH",
      "contextFiles entries must be relative paths.",
      `absolute context file path was rejected: ${input.relativePath}`,
    );
  }

  if (hasParentDirectoryTraversal(input.relativePath)) {
    throw new WorkloadContextIngestionError(
      "VALIDATION_CONTEXT_FILE_PATH_TRAVERSAL",
      "contextFiles entries must not contain '..' path traversal segments.",
      `context file traversal was rejected: ${input.relativePath}`,
    );
  }

  const resolvedPath = resolve(input.packRootDir, input.relativePath);

  let canonicalContextPath: string;
  try {
    canonicalContextPath = await realpath(resolvedPath);
  } catch (error) {
    throw new WorkloadContextIngestionError(
      "VALIDATION_CONTEXT_FILE_NOT_FOUND",
      "contextFiles entries must reference existing files in the pack directory.",
      `failed to resolve context file '${resolvedPath}': ${toErrorMessage(error)}`,
    );
  }

  if (!isPathWithinRoot(canonicalContextPath, input.packRootDir)) {
    throw new WorkloadContextIngestionError(
      "VALIDATION_CONTEXT_FILE_OUTSIDE_PACK",
      "contextFiles entries must stay within the pack directory.",
      `context file '${canonicalContextPath}' escapes pack root '${input.packRootDir}'.`,
    );
  }

  let contextStats: Awaited<ReturnType<typeof stat>>;
  try {
    contextStats = await stat(canonicalContextPath);
  } catch (error) {
    throw new WorkloadContextIngestionError(
      "VALIDATION_CONTEXT_FILE_NOT_FOUND",
      "contextFiles entries must reference existing files in the pack directory.",
      `failed to stat context file '${canonicalContextPath}': ${toErrorMessage(error)}`,
    );
  }

  if (!contextStats.isFile()) {
    throw new WorkloadContextIngestionError(
      "VALIDATION_CONTEXT_FILE_NOT_FILE",
      "contextFiles entries must reference regular files.",
      `context path '${canonicalContextPath}' is not a regular file.`,
    );
  }

  const readLimit = Math.max(1, input.byteLimit);
  const fileHandle = await open(canonicalContextPath, "r");

  try {
    const readBuffer = Buffer.allocUnsafe(readLimit + 1);
    const { bytesRead } = await fileHandle.read(readBuffer, 0, readBuffer.length, 0);
    const sourceBytesUsed = Math.min(bytesRead, readLimit);
    const sourceBytes = readBuffer.subarray(0, sourceBytesUsed);
    const exceededReadBudget = bytesRead > readLimit;
    const sourceText = sourceBytes.toString("utf8");

    return {
      injectedText: exceededReadBudget
        ? `${sourceText}${CONTEXT_TRUNCATION_MARKER}`
        : sourceText,
      sourceBytesUsed,
      truncated: exceededReadBudget,
    };
  } catch (error) {
    throw new WorkloadContextIngestionError(
      "VALIDATION_CONTEXT_FILE_READ_FAILED",
      "Failed to read a context file from the workload pack.",
      `failed to read context file '${canonicalContextPath}': ${toErrorMessage(error)}`,
    );
  } finally {
    await fileHandle.close();
  }
}

function buildWorkloadPackProvenance(
  workload: StarterWorkload,
  contextDigests: readonly WorkloadContextDigest[],
): WorkloadPackProvenance {
  const digestInput = `${workload.canonicalPackJson}\n${stableJsonStringify(contextDigests)}`;

  return {
    schemaVersion: workload.schemaVersion,
    version: workload.version,
    source: workload.source,
    digestSha256: createSha256Hex(Buffer.from(digestInput, "utf8")),
    contextDigests,
  };
}

function hasContextFiles(workload: StarterWorkload): boolean {
  return workload.cases.some((workloadCase) => workloadCase.contextFiles.length > 0);
}

function hasParentDirectoryTraversal(pathValue: string): boolean {
  return pathValue.split(/[\\/]+/).some((segment) => segment === "..");
}

function isPathWithinRoot(path: string, rootDir: string): boolean {
  const relativePath = relative(rootDir, path);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function createSha256Hex(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

function compareContextDigestEntries(
  left: WorkloadContextDigest,
  right: WorkloadContextDigest,
): number {
  if (left.path !== right.path) {
    return compareLexicographic(left.path, right.path);
  }

  if (left.sha256 !== right.sha256) {
    return compareLexicographic(left.sha256, right.sha256);
  }

  if (left.bytes !== right.bytes) {
    return left.bytes - right.bytes;
  }

  if (left.truncated === right.truncated) {
    return 0;
  }

  return left.truncated ? 1 : -1;
}

function compareLexicographic(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return sanitizeControlCharacters(error.message);
  }

  return sanitizeControlCharacters(String(error));
}
