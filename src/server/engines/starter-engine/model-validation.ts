import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { EngineValidationIssue } from "../engine-plugin.ts";
import type { ModelIdentifierValidationResult } from "./types.ts";

export async function validateModelIdentifier(
  modelIdentifier: string,
  modelRoots: readonly string[],
): Promise<ModelIdentifierValidationResult> {
  const issues: EngineValidationIssue[] = [];
  const path = "model.identifier";
  const normalized = modelIdentifier.trim();

  if (normalized.length === 0) {
    issues.push({
      code: "MODEL_IDENTIFIER_EMPTY",
      message: "model.identifier must not be empty.",
      path,
    });

    return {
      ok: false,
      issues,
    };
  }

  if (normalized.includes("://")) {
    issues.push({
      code: "MODEL_IDENTIFIER_NOT_LOCAL_PATH",
      message: "model.identifier must be a local filesystem path.",
      path,
    });
  }

  if (!normalized.toLowerCase().endsWith(".gguf")) {
    issues.push({
      code: "MODEL_IDENTIFIER_EXTENSION_INVALID",
      message: "model.identifier must point to a .gguf file.",
      path,
    });
  }

  // Canonicalize before root checks so symlinks cannot bypass model root
  // confinement (for example, a symlink inside roots pointing outside).
  const absolutePath = resolve(normalized);
  let canonicalModelPath: string;

  try {
    canonicalModelPath = await realpath(absolutePath);
  } catch {
    issues.push({
      code: "MODEL_IDENTIFIER_NOT_FOUND",
      message: "model.identifier does not exist.",
      path,
    });

    return {
      ok: false,
      issues,
    };
  }

  let modelStats: Awaited<ReturnType<typeof stat>>;
  try {
    modelStats = await stat(canonicalModelPath);
  } catch {
    issues.push({
      code: "MODEL_IDENTIFIER_NOT_FOUND",
      message: "model.identifier is not accessible.",
      path,
    });

    return {
      ok: false,
      issues,
    };
  }

  if (!modelStats.isFile()) {
    issues.push({
      code: "MODEL_IDENTIFIER_NOT_FILE",
      message: "model.identifier must reference a file, not a directory.",
      path,
    });
  }

  try {
    await access(canonicalModelPath, fsConstants.R_OK);
  } catch {
    issues.push({
      code: "MODEL_IDENTIFIER_NOT_READABLE",
      message: "model.identifier must reference a readable file.",
      path,
    });
  }

  if (modelRoots.length > 0) {
    const normalizedModelRoots = await resolveModelRoots([...modelRoots], path, issues);

    if (
      normalizedModelRoots.length > 0 &&
      !normalizedModelRoots.some((rootPath) => isPathInsideRoot(canonicalModelPath, rootPath))
    ) {
      issues.push({
        code: "MODEL_IDENTIFIER_OUTSIDE_ALLOWED_ROOTS",
        message: "model.identifier is outside CHIMERA_MODEL_ROOTS after resolving symlinks.",
        path,
      });
    }
  }

  if (issues.length > 0) {
    return {
      ok: false,
      issues,
    };
  }

  return {
    ok: true,
    normalizedIdentifier: canonicalModelPath,
  };
}

async function resolveModelRoots(
  modelRoots: string[],
  issuePath: string,
  issues: EngineValidationIssue[],
): Promise<string[]> {
  const normalizedRoots = new Set<string>();

  for (const [index, root] of modelRoots.entries()) {
    const absoluteRoot = resolve(root);
    let canonicalRoot: string;

    try {
      canonicalRoot = await realpath(absoluteRoot);
    } catch {
      issues.push({
        code: "MODEL_ROOT_NOT_FOUND",
        message: `CHIMERA_MODEL_ROOTS entry at index ${index} does not exist.`,
        path: issuePath,
      });
      continue;
    }

    let rootStats: Awaited<ReturnType<typeof stat>>;
    try {
      rootStats = await stat(canonicalRoot);
    } catch {
      issues.push({
        code: "MODEL_ROOT_NOT_FOUND",
        message: `CHIMERA_MODEL_ROOTS entry at index ${index} is not accessible.`,
        path: issuePath,
      });
      continue;
    }

    if (!rootStats.isDirectory()) {
      issues.push({
        code: "MODEL_ROOT_NOT_DIRECTORY",
        message: `CHIMERA_MODEL_ROOTS entry at index ${index} is not a directory.`,
        path: issuePath,
      });
      continue;
    }

    normalizedRoots.add(canonicalRoot);
  }

  return Array.from(normalizedRoots);
}

function isPathInsideRoot(filePath: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
