import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { toErrorMessage } from "../error-utils.ts";
import { sanitizeControlCharacters } from "../http/sanitize.ts";
import type { ServerLogger } from "../logging.ts";

export interface ConstrainedPackPaths {
  packDir: string;
  workloadPath: string;
}

export async function resolveConstrainedPackPaths(input: {
  packDir: string;
  workloadPath: string;
  rootDir: string;
  logger: ServerLogger;
}): Promise<ConstrainedPackPaths | null> {
  const canonicalPackDir = await resolveCanonicalPathOrLog(
    input.packDir,
    input.packDir,
    input.logger,
  );
  if (!canonicalPackDir) {
    return null;
  }

  if (!isPathWithinRoot(canonicalPackDir, input.rootDir)) {
    logPackSkipped(input.logger, input.packDir, "PACK_DIR_OUTSIDE_ROOT");
    return null;
  }

  const packDirStats = await statPathOrLog(canonicalPackDir, canonicalPackDir, input.logger);
  if (!packDirStats) {
    return null;
  }

  if (!packDirStats.isDirectory()) {
    logPackSkipped(input.logger, canonicalPackDir, "PACK_DIR_NOT_DIRECTORY");
    return null;
  }

  const canonicalWorkloadPath = await resolveCanonicalPathOrLog(
    input.workloadPath,
    canonicalPackDir,
    input.logger,
  );
  if (!canonicalWorkloadPath) {
    return null;
  }

  if (!isPathWithinRoot(canonicalWorkloadPath, canonicalPackDir)) {
    logPackSkipped(input.logger, canonicalPackDir, "WORKLOAD_JSON_OUTSIDE_PACK");
    return null;
  }

  const workloadStats = await statPathOrLog(canonicalWorkloadPath, canonicalPackDir, input.logger);
  if (!workloadStats) {
    return null;
  }

  if (!workloadStats.isFile()) {
    logPackSkipped(input.logger, canonicalPackDir, "WORKLOAD_JSON_NOT_FILE");
    return null;
  }

  return {
    packDir: canonicalPackDir,
    workloadPath: canonicalWorkloadPath,
  };
}

async function resolveCanonicalPathOrLog(
  path: string,
  packDirForLog: string,
  logger: ServerLogger,
): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    logPackSkipped(logger, packDirForLog, sanitizeControlCharacters(toErrorMessage(error)));
    return null;
  }
}

async function statPathOrLog(
  path: string,
  packDirForLog: string,
  logger: ServerLogger,
): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path);
  } catch (error) {
    logPackSkipped(logger, packDirForLog, sanitizeControlCharacters(toErrorMessage(error)));
    return null;
  }
}

function logPackSkipped(logger: ServerLogger, packDir: string, reason: string): void {
  logger.error(
    `[chimera-bench] event=workloads.scan.pack_skipped` +
      ` packDir=${sanitizeControlCharacters(packDir)}` +
      ` reason=${sanitizeControlCharacters(reason)}`,
  );
}

function isPathWithinRoot(path: string, rootDir: string): boolean {
  const relativePath = relative(rootDir, path);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
