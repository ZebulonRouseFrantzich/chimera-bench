/**
 * Workload registry for built-in and filesystem packs.
 *
 * The registry loads built-ins plus one-level filesystem packs, applies a
 * deterministic duplicate policy, and supports explicit reloads with cooldown
 * and in-flight deduplication.
 */
import type { Dirent } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { toErrorMessage } from "../error-utils.ts";
import { sanitizeControlCharacters } from "../http/sanitize.ts";
import {
  DEFAULT_SERVER_LOGGER,
  type ServerLogger,
} from "../logging.ts";
import {
  listBuiltInWorkloadPacks,
  type StarterWorkload,
} from "../runs/starter-workload.ts";
import { resolveConstrainedPackPaths } from "./pack-discovery.ts";
import {
  toRuntimeWorkload,
  validateWorkloadPackDefinition,
} from "./pack-schema.ts";

const WORKLOAD_FILENAME = "workload.json";
const DEFAULT_RELOAD_COOLDOWN_MS = 5_000;
const DEFAULT_INITIAL_LOAD_FAILURE_BACKOFF_MS = 1_000;
const RESTRICTED_POSIX_ROOT_PREFIXES = ["/proc", "/sys", "/dev"] as const;

interface FilesystemWorkloadCandidate {
  packDir: string;
  workload: StarterWorkload;
}

interface FilesystemScanResult {
  candidates: FilesystemWorkloadCandidate[];
  skippedInvalidPacks: number;
}

export interface WorkloadSummary {
  workloadId: string;
  displayName: string;
  version: string;
  promptCount: number;
  source: "built-in" | "filesystem";
}

export interface WorkloadReloadStats {
  discoveredPacks: number;
  skippedInvalidPacks: number;
  duplicateIdSkips: number;
}

export class WorkloadReloadCooldownError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Workload reload is cooling down.");
    this.name = "WorkloadReloadCooldownError";
  }
}

export class WorkloadInitialLoadBackoffError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Workload registry initial load is cooling down after a failure.");
    this.name = "WorkloadInitialLoadBackoffError";
  }
}

interface WorkloadRegistryOptions {
  workloadRoots: readonly string[];
  logger?: ServerLogger;
  now?: () => number;
  reloadCooldownMs?: number;
  initialLoadFailureBackoffMs?: number;
}

export class WorkloadRegistry {
  private readonly workloadRoots: readonly string[];
  private readonly logger: ServerLogger;
  private readonly now: () => number;
  private readonly reloadCooldownMs: number;
  private readonly initialLoadFailureBackoffMs: number;
  private workloadsById = new Map<string, StarterWorkload>();
  private initialized = false;
  private initialLoadInFlight: Promise<void> | null = null;
  private reloadInFlight: Promise<WorkloadReloadStats> | null = null;
  private lastReloadCompletedAtMs = 0;
  private nextInitialLoadAttemptAtMs = 0;

  constructor(options: WorkloadRegistryOptions) {
    this.workloadRoots = options.workloadRoots;
    this.logger = options.logger ?? DEFAULT_SERVER_LOGGER;
    this.now = options.now ?? Date.now;
    this.reloadCooldownMs = options.reloadCooldownMs ?? DEFAULT_RELOAD_COOLDOWN_MS;
    this.initialLoadFailureBackoffMs =
      options.initialLoadFailureBackoffMs ?? DEFAULT_INITIAL_LOAD_FAILURE_BACKOFF_MS;
  }

  async listSummaries(): Promise<WorkloadSummary[]> {
    await this.ensureInitialized();

    return [...this.workloadsById.values()]
      .map((workload) => {
        return {
          workloadId: workload.workloadId,
          displayName: workload.displayName,
          version: workload.version,
          promptCount: workload.cases.length,
          source: workload.source,
        };
      })
      .sort((left, right) => {
        return compareLexicographic(left.workloadId, right.workloadId);
      });
  }

  async getWorkload(workloadId: string): Promise<StarterWorkload | null> {
    await this.ensureInitialized();
    return this.workloadsById.get(workloadId) ?? null;
  }

  async reload(): Promise<WorkloadReloadStats> {
    await this.ensureInitialized();

    if (this.reloadInFlight) {
      return this.reloadInFlight;
    }

    const nowMs = this.now();
    const elapsedSinceLastReloadMs = nowMs - this.lastReloadCompletedAtMs;
    if (
      this.lastReloadCompletedAtMs > 0 &&
      elapsedSinceLastReloadMs < this.reloadCooldownMs
    ) {
      throw new WorkloadReloadCooldownError(
        Math.max(1, this.reloadCooldownMs - elapsedSinceLastReloadMs),
      );
    }

    const reloadPromise = this.performScan("reload").finally(() => {
      this.reloadInFlight = null;
    });
    this.reloadInFlight = reloadPromise;
    return reloadPromise;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initialLoadInFlight) {
      await this.initialLoadInFlight;
      return;
    }

    const nowMs = this.now();
    if (nowMs < this.nextInitialLoadAttemptAtMs) {
      throw new WorkloadInitialLoadBackoffError(
        Math.max(1, this.nextInitialLoadAttemptAtMs - nowMs),
      );
    }

    this.initialLoadInFlight = (async () => {
      await this.performScan("startup");
      this.initialized = true;
    })();

    try {
      await this.initialLoadInFlight;
      this.nextInitialLoadAttemptAtMs = 0;
    } catch (error) {
      this.nextInitialLoadAttemptAtMs = this.now() + this.initialLoadFailureBackoffMs;
      throw error;
    } finally {
      this.initialLoadInFlight = null;
    }
  }

  private async performScan(trigger: "startup" | "reload"): Promise<WorkloadReloadStats> {
    const startedAtMs = this.now();
    const builtIns = await this.loadValidatedBuiltIns();
    const filesystemScan = await this.scanFilesystemWorkloads();

    const mergedById = new Map<string, StarterWorkload>();
    const selectedSourceByWorkloadId = new Map<string, string>();
    for (const workload of builtIns) {
      mergedById.set(workload.workloadId, workload);
      selectedSourceByWorkloadId.set(workload.workloadId, "built-in");
    }

    let duplicateIdSkips = 0;
    for (const candidate of filesystemScan.candidates) {
      const selectedSource = selectedSourceByWorkloadId.get(candidate.workload.workloadId);
      if (selectedSource) {
        duplicateIdSkips += 1;
        this.logger.info(
          `[chimera-bench] event=workloads.scan.duplicate_id_skipped` +
            ` workloadId=${sanitizeControlCharacters(candidate.workload.workloadId)}` +
            ` selectedSource=${sanitizeControlCharacters(selectedSource)}` +
            ` skippedSource=${sanitizeControlCharacters(candidate.packDir)}`,
        );
        continue;
      }

      mergedById.set(candidate.workload.workloadId, candidate.workload);
      selectedSourceByWorkloadId.set(candidate.workload.workloadId, candidate.packDir);
    }

    this.workloadsById = mergedById;

    if (trigger === "reload") {
      this.lastReloadCompletedAtMs = this.now();
    }

    const stats: WorkloadReloadStats = {
      discoveredPacks: mergedById.size,
      skippedInvalidPacks: filesystemScan.skippedInvalidPacks,
      duplicateIdSkips,
    };

    const elapsedMs = Math.max(0, this.now() - startedAtMs);
    this.logger.info(
      `[chimera-bench] event=workloads.scan trigger=${trigger}` +
        ` discoveredPacks=${stats.discoveredPacks}` +
        ` skippedInvalidPacks=${stats.skippedInvalidPacks}` +
        ` duplicateIdSkips=${stats.duplicateIdSkips}` +
        ` elapsedMs=${elapsedMs}`,
    );

    return stats;
  }

  private async loadValidatedBuiltIns(): Promise<StarterWorkload[]> {
    const builtIns: StarterWorkload[] = [];

    for (const pack of listBuiltInWorkloadPacks()) {
      const validation = await validateWorkloadPackDefinition(pack);
      if (!validation.ok) {
        throw new Error(
          `Built-in workload '${pack.workloadId}' failed validation: ${validation.error.logReason}`,
        );
      }

      builtIns.push(toRuntimeWorkload(validation.value, "built-in"));
    }

    builtIns.sort((left, right) => {
      return compareLexicographic(left.workloadId, right.workloadId);
    });
    return builtIns;
  }

  private async scanFilesystemWorkloads(): Promise<FilesystemScanResult> {
    const discoveredCandidates: FilesystemWorkloadCandidate[] = [];
    let skippedInvalidPacks = 0;

    const workloadRoots = await this.resolveFilesystemRoots();
    for (const rootDir of workloadRoots) {
      let entries: Dirent<string>[];

      try {
        entries = await readdir(rootDir, {
          withFileTypes: true,
          encoding: "utf8",
        });
      } catch (error) {
        this.logger.error(
          `[chimera-bench] event=workloads.scan.root_skipped` +
            ` rootDir=${sanitizeControlCharacters(rootDir)}` +
            ` reason=${sanitizeControlCharacters(toErrorMessage(error))}`,
        );
        continue;
      }

      entries.sort((left, right) => {
        return compareLexicographic(left.name, right.name);
      });

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const packDir = join(rootDir, entry.name);
        const workloadPath = join(packDir, WORKLOAD_FILENAME);

        const hasWorkloadJson = await isRegularFile(workloadPath);
        if (!hasWorkloadJson) {
          continue;
        }

        const constrainedPaths = await resolveConstrainedPackPaths({
          packDir,
          workloadPath,
          rootDir,
          logger: this.logger,
        });
        if (!constrainedPaths) {
          skippedInvalidPacks += 1;
          continue;
        }

        const loadedWorkload = await this.tryLoadFilesystemWorkload(
          constrainedPaths.packDir,
          constrainedPaths.workloadPath,
        );
        if (!loadedWorkload) {
          skippedInvalidPacks += 1;
          continue;
        }

        discoveredCandidates.push({
          packDir: constrainedPaths.packDir,
          workload: loadedWorkload,
        });
      }
    }

    discoveredCandidates.sort((left, right) => {
      return compareLexicographic(left.packDir, right.packDir);
    });

    return {
      candidates: discoveredCandidates,
      skippedInvalidPacks,
    };
  }

  private async resolveFilesystemRoots(): Promise<string[]> {
    const rootsByPath = new Map<string, string>();

    for (const rootCandidate of this.workloadRoots) {
      const resolvedRoot = resolve(rootCandidate);
      let canonicalRoot: string;

      try {
        canonicalRoot = await realpath(resolvedRoot);
      } catch (error) {
        this.logger.error(
          `[chimera-bench] event=workloads.scan.root_skipped` +
            ` rootDir=${sanitizeControlCharacters(resolvedRoot)}` +
            ` reason=${sanitizeControlCharacters(toErrorMessage(error))}`,
        );
        continue;
      }

      let rootStats: Awaited<ReturnType<typeof stat>>;
      try {
        rootStats = await stat(canonicalRoot);
      } catch (error) {
        this.logger.error(
          `[chimera-bench] event=workloads.scan.root_skipped` +
            ` rootDir=${sanitizeControlCharacters(canonicalRoot)}` +
            ` reason=${sanitizeControlCharacters(toErrorMessage(error))}`,
        );
        continue;
      }

      if (!rootStats.isDirectory()) {
        this.logger.error(
          `[chimera-bench] event=workloads.scan.root_skipped` +
            ` rootDir=${sanitizeControlCharacters(canonicalRoot)}` +
            ` reason=not_a_directory`,
        );
        continue;
      }

      if (isRestrictedPosixRoot(canonicalRoot)) {
        this.logger.error(
          `[chimera-bench] event=workloads.scan.root_skipped` +
            ` rootDir=${sanitizeControlCharacters(canonicalRoot)}` +
            ` reason=restricted_root`,
        );
        continue;
      }

      rootsByPath.set(canonicalRoot, canonicalRoot);
    }

    return [...rootsByPath.values()].sort(compareLexicographic);
  }

  private async tryLoadFilesystemWorkload(
    packDir: string,
    workloadPath: string,
  ): Promise<StarterWorkload | null> {
    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(await readFile(workloadPath, "utf8")) as unknown;
    } catch (error) {
      this.logger.error(
        `[chimera-bench] event=workloads.scan.pack_skipped` +
          ` packDir=${sanitizeControlCharacters(packDir)}` +
          ` reason=${sanitizeControlCharacters(toErrorMessage(error))}`,
      );
      return null;
    }

    const validation = await validateWorkloadPackDefinition(rawPayload, {
      packRootDir: packDir,
    });
    if (!validation.ok) {
      this.logger.error(
        `[chimera-bench] event=workloads.scan.pack_skipped` +
          ` packDir=${sanitizeControlCharacters(packDir)}` +
          ` reason=${sanitizeControlCharacters(validation.error.logReason)}`,
      );
      return null;
    }

    return toRuntimeWorkload(validation.value, "filesystem", packDir);
  }
}

function isRestrictedPosixRoot(path: string): boolean {
  if (process.platform === "win32") {
    return false;
  }

  return RESTRICTED_POSIX_ROOT_PREFIXES.some((prefix) => {
    return path === prefix || path.startsWith(`${prefix}/`);
  });
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const pathStat = await stat(path);
    return pathStat.isFile();
  } catch {
    return false;
  }
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
