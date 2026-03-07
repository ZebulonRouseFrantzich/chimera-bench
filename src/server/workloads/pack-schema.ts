/**
 * Workload pack schema + filesystem safety validation.
 *
 * This module validates `workload.json` payloads for both built-in and
 * filesystem-backed packs. Filesystem context references are checked with
 * realpath-based confinement to keep reads inside the selected pack root.
 */
import { Buffer } from "node:buffer";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { formatValidationIssues } from "../http/validation-issues.ts";
import { sanitizeControlCharacters } from "../http/sanitize.ts";
import {
  convertPackToStarterWorkload,
  type StarterWorkload,
  type WorkloadPackDefinition,
  WORKLOAD_ID_PATTERN,
} from "../runs/starter-workload.ts";

export const MAX_PROMPTS_PER_PACK = 256;
export const MAX_MESSAGES_PER_PROMPT = 32;
export const MAX_MESSAGE_CONTENT_BYTES = 64 * 1024;
export const MAX_CONTEXT_FILES_PER_PROMPT = 32;
const MAX_WORKLOAD_ID_LENGTH = 128;
const MAX_PROMPT_ID_LENGTH = 128;
const MAX_CASE_ID_LENGTH = 128;

const WorkloadMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().min(1),
  })
  .strict();

const WorkloadPromptSchema = z
  .object({
    promptId: z.string().min(1).max(MAX_PROMPT_ID_LENGTH),
    caseId: z.string().min(1).max(MAX_CASE_ID_LENGTH),
    messages: z.array(WorkloadMessageSchema).min(1).max(MAX_MESSAGES_PER_PROMPT),
    contextFiles: z.array(z.string().min(1)).max(MAX_CONTEXT_FILES_PER_PROMPT).optional(),
    notes: z.string().optional(),
  })
  .strict()
  .superRefine((prompt, context) => {
    for (let index = 0; index < prompt.messages.length; index += 1) {
      const message = prompt.messages[index];
      if (!message) {
        continue;
      }

      const byteLength = Buffer.byteLength(message.content, "utf8");
      if (byteLength > MAX_MESSAGE_CONTENT_BYTES) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["messages", index, "content"],
          message:
            `Message content exceeds ${MAX_MESSAGE_CONTENT_BYTES} UTF-8 bytes ` +
            `(${byteLength} bytes).`,
        });
      }
    }
  });

export const WorkloadPackSchema = z
  .object({
    schemaVersion: z.literal(1),
    workloadId: z.string().min(1).max(MAX_WORKLOAD_ID_LENGTH).regex(WORKLOAD_ID_PATTERN),
    displayName: z.string().min(1),
    version: z.string().min(1),
    prompts: z.array(WorkloadPromptSchema).min(1).max(MAX_PROMPTS_PER_PACK),
  })
  .strict();

export interface WorkloadValidationIssue {
  code: string;
  message: string;
  path: string;
  logReason: string;
}

export interface WorkloadPackValidationError {
  code: "VALIDATION_WORKLOAD_PACK_INVALID";
  message: string;
  issues: readonly WorkloadValidationIssue[];
  logReason: string;
}

export type WorkloadPackValidationResult =
  | {
      ok: true;
      value: WorkloadPackDefinition;
    }
  | {
      ok: false;
      error: WorkloadPackValidationError;
    };

export async function validateWorkloadPackDefinition(
  rawPack: unknown,
  options: {
    packRootDir?: string;
  } = {},
): Promise<WorkloadPackValidationResult> {
  const parsedPack = WorkloadPackSchema.safeParse(rawPack);
  if (!parsedPack.success) {
    const issues = formatValidationIssues(parsedPack.error.issues).map((issue) => {
      return {
        code: "VALIDATION_WORKLOAD_SCHEMA_INVALID",
        message: issue.message,
        path: issue.path,
        logReason: `path=${issue.path} reason=${issue.message}`,
      } satisfies WorkloadValidationIssue;
    });

    return buildValidationFailure(issues);
  }

  const contextValidation = await validateContextFileReferences(
    parsedPack.data,
    options.packRootDir,
  );
  if (contextValidation.length > 0) {
    return buildValidationFailure(contextValidation);
  }

  return {
    ok: true,
    value: parsedPack.data,
  };
}

export function toRuntimeWorkload(
  pack: WorkloadPackDefinition,
  source: "built-in" | "filesystem",
  packRootDir?: string,
): StarterWorkload {
  return convertPackToStarterWorkload(pack, source, packRootDir);
}

async function validateContextFileReferences(
  pack: WorkloadPackDefinition,
  packRootDir: string | undefined,
): Promise<WorkloadValidationIssue[]> {
  const issues: WorkloadValidationIssue[] = [];
  const promptContextCount = pack.prompts.reduce((count, prompt) => {
    return count + (prompt.contextFiles?.length ?? 0);
  }, 0);

  if (promptContextCount === 0) {
    return issues;
  }

  if (!packRootDir) {
    issues.push({
      code: "VALIDATION_CONTEXT_ROOT_REQUIRED",
      message: "contextFiles are only supported for filesystem workload packs.",
      path: "prompts",
      logReason: "contextFiles were declared but no filesystem pack root was provided.",
    });
    return issues;
  }

  const canonicalPackRoot = await resolvePackRoot(packRootDir, issues);
  if (!canonicalPackRoot) {
    return issues;
  }

  for (let promptIndex = 0; promptIndex < pack.prompts.length; promptIndex += 1) {
    const prompt = pack.prompts[promptIndex];
    if (!prompt || !prompt.contextFiles) {
      continue;
    }

    for (
      let contextFileIndex = 0;
      contextFileIndex < prompt.contextFiles.length;
      contextFileIndex += 1
    ) {
      const contextFile = prompt.contextFiles[contextFileIndex];
      if (typeof contextFile !== "string") {
        continue;
      }

      const issuePath = `prompts[${promptIndex}].contextFiles[${contextFileIndex}]`;

      if (isAbsolute(contextFile)) {
        issues.push({
          code: "VALIDATION_CONTEXT_FILE_ABSOLUTE_PATH",
          message: "contextFiles entries must be relative paths.",
          path: issuePath,
          logReason: `absolute path was rejected: ${contextFile}`,
        });
        continue;
      }

      if (hasParentDirectoryTraversal(contextFile)) {
        issues.push({
          code: "VALIDATION_CONTEXT_FILE_PATH_TRAVERSAL",
          message: "contextFiles entries must not contain '..' path traversal segments.",
          path: issuePath,
          logReason: `path traversal was rejected: ${contextFile}`,
        });
        continue;
      }

      const resolvedPath = resolve(canonicalPackRoot, contextFile);
      let canonicalContextPath: string;
      try {
        canonicalContextPath = await realpath(resolvedPath);
      } catch (error) {
        issues.push({
          code: "VALIDATION_CONTEXT_FILE_NOT_FOUND",
          message: "contextFiles entries must reference existing files in the pack directory.",
          path: issuePath,
          logReason:
            `failed to resolve context file '${resolvedPath}': ` +
            sanitizeControlCharacters(toErrorMessage(error)),
        });
        continue;
      }

      if (!isPathWithinRoot(canonicalContextPath, canonicalPackRoot)) {
        issues.push({
          code: "VALIDATION_CONTEXT_FILE_OUTSIDE_PACK",
          message: "contextFiles entries must stay within the pack directory.",
          path: issuePath,
          logReason:
            `context file '${canonicalContextPath}' escapes pack root '${canonicalPackRoot}'.`,
        });
        continue;
      }

      try {
        const pathStat = await stat(canonicalContextPath);
        if (!pathStat.isFile()) {
          issues.push({
            code: "VALIDATION_CONTEXT_FILE_NOT_FILE",
            message: "contextFiles entries must reference regular files.",
            path: issuePath,
            logReason: `context path '${canonicalContextPath}' is not a regular file.`,
          });
        }
      } catch (error) {
        issues.push({
          code: "VALIDATION_CONTEXT_FILE_NOT_FOUND",
          message: "contextFiles entries must reference existing files in the pack directory.",
          path: issuePath,
          logReason:
            `failed to stat context file '${canonicalContextPath}': ` +
            sanitizeControlCharacters(toErrorMessage(error)),
        });
      }
    }
  }

  return issues;
}

async function resolvePackRoot(
  packRootDir: string,
  issues: WorkloadValidationIssue[],
): Promise<string | null> {
  const resolvedRoot = resolve(packRootDir);
  let canonicalRoot: string;

  try {
    canonicalRoot = await realpath(resolvedRoot);
  } catch (error) {
    issues.push({
      code: "VALIDATION_CONTEXT_ROOT_INVALID",
      message: "Workload pack root is not accessible.",
      path: "(packRoot)",
      logReason:
        `failed to resolve workload pack root '${resolvedRoot}': ` +
        sanitizeControlCharacters(toErrorMessage(error)),
    });
    return null;
  }

  try {
    const rootStat = await stat(canonicalRoot);
    if (!rootStat.isDirectory()) {
      issues.push({
        code: "VALIDATION_CONTEXT_ROOT_INVALID",
        message: "Workload pack root is not a directory.",
        path: "(packRoot)",
        logReason: `workload pack root '${canonicalRoot}' is not a directory.`,
      });
      return null;
    }
  } catch (error) {
    issues.push({
      code: "VALIDATION_CONTEXT_ROOT_INVALID",
      message: "Workload pack root is not accessible.",
      path: "(packRoot)",
      logReason:
        `failed to stat workload pack root '${canonicalRoot}': ` +
        sanitizeControlCharacters(toErrorMessage(error)),
    });
    return null;
  }

  return canonicalRoot;
}

function buildValidationFailure(
  issues: readonly WorkloadValidationIssue[],
): WorkloadPackValidationResult {
  return {
    ok: false,
    error: {
      code: "VALIDATION_WORKLOAD_PACK_INVALID",
      message: "Workload pack is invalid.",
      issues,
      logReason: issues
        .map((issue) => {
          return `${issue.code}:${issue.path}`;
        })
        .join("; "),
    },
  };
}

function hasParentDirectoryTraversal(pathValue: string): boolean {
  return pathValue
    .split(/[\\/]+/)
    .some((segment) => segment === "..");
}

function isPathWithinRoot(path: string, rootDir: string): boolean {
  const relativePath = relative(rootDir, path);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
