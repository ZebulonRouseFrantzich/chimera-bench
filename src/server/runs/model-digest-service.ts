/**
 * Model digest resolution with deterministic in-process caching.
 *
 * Local model digests can be expensive for large files. This service caches
 * digests by resolved path + size + mtime and deduplicates in-flight hash work.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { sanitizeControlCharacters } from "../http/sanitize.ts";
import {
  DEFAULT_SERVER_LOGGER,
  type ServerLogger,
} from "../logging.ts";

export const DEFAULT_MODEL_DIGEST_CACHE_MAX_ENTRIES = 128;

export interface ModelInfoProvenance {
  resolvedPath?: string;
  bytes: number | null;
  mtimeMs: number | null;
  digestSha256: string | null;
  unavailableReason?: string;
}

interface ModelDigestServiceOptions {
  logger?: ServerLogger;
  now?: () => number;
  maxEntries?: number;
}

export class ModelDigestService {
  private readonly logger: ServerLogger;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly digestCache = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(options: ModelDigestServiceOptions = {}) {
    this.logger = options.logger ?? DEFAULT_SERVER_LOGGER;
    this.now = options.now ?? Date.now;
    this.maxEntries = Math.max(0, options.maxEntries ?? DEFAULT_MODEL_DIGEST_CACHE_MAX_ENTRIES);
  }

  async resolveModelInfo(input: {
    target: "local" | "ssh";
    modelIdentifier: string;
    requestId?: string;
  }): Promise<ModelInfoProvenance> {
    if (input.target === "ssh") {
      return {
        bytes: null,
        mtimeMs: null,
        digestSha256: null,
        unavailableReason: "MODEL_DIGEST_UNAVAILABLE_REMOTE_TARGET",
      };
    }

    let resolvedPath: string;
    try {
      resolvedPath = await realpath(input.modelIdentifier);
    } catch {
      return {
        bytes: null,
        mtimeMs: null,
        digestSha256: null,
        unavailableReason: "MODEL_DIGEST_UNAVAILABLE_PATH_NOT_FOUND",
      };
    }

    let modelStats: Awaited<ReturnType<typeof stat>>;
    try {
      modelStats = await stat(resolvedPath);
    } catch {
      return {
        resolvedPath,
        bytes: null,
        mtimeMs: null,
        digestSha256: null,
        unavailableReason: "MODEL_DIGEST_UNAVAILABLE_STAT_FAILED",
      };
    }

    if (!modelStats.isFile()) {
      return {
        resolvedPath,
        bytes: null,
        mtimeMs: null,
        digestSha256: null,
        unavailableReason: "MODEL_DIGEST_UNAVAILABLE_NOT_FILE",
      };
    }

    const bytes = modelStats.size;
    const mtimeMs = modelStats.mtimeMs;
    const cacheKey = buildDigestCacheKey(resolvedPath, bytes, mtimeMs);
    const digestStartedAt = this.now();

    if (this.maxEntries > 0) {
      const cached = this.digestCache.get(cacheKey);
      if (cached) {
        this.logCacheEvent({
          requestId: input.requestId,
          cache: "hit",
          resolvedPath,
          bytes,
          mtimeMs,
        });
        return {
          resolvedPath,
          bytes,
          mtimeMs,
          digestSha256: cached,
        };
      }

      const inFlightDigest = this.inFlight.get(cacheKey);
      if (inFlightDigest) {
        this.logCacheEvent({
          requestId: input.requestId,
          cache: "inflight",
          resolvedPath,
          bytes,
          mtimeMs,
        });
        const digestSha256 = await inFlightDigest;
        return {
          resolvedPath,
          bytes,
          mtimeMs,
          digestSha256,
        };
      }

      this.logCacheEvent({
        requestId: input.requestId,
        cache: "miss",
        resolvedPath,
        bytes,
        mtimeMs,
      });

      const digestPromise = this.computeDigestSha256(resolvedPath).finally(() => {
        this.inFlight.delete(cacheKey);
      });
      this.inFlight.set(cacheKey, digestPromise);

      try {
        const digestSha256 = await digestPromise;
        this.digestCache.set(cacheKey, digestSha256);
        this.enforceCacheBudget();

        this.logDigestComputation({
          requestId: input.requestId,
          resolvedPath,
          bytes,
          elapsedMs: this.now() - digestStartedAt,
        });

        return {
          resolvedPath,
          bytes,
          mtimeMs,
          digestSha256,
        };
      } catch (error) {
        this.logDigestFailure({
          requestId: input.requestId,
          resolvedPath,
          reason: toErrorMessage(error),
        });
        return {
          resolvedPath,
          bytes,
          mtimeMs,
          digestSha256: null,
          unavailableReason: "MODEL_DIGEST_UNAVAILABLE_HASH_FAILED",
        };
      }
    }

    this.logCacheEvent({
      requestId: input.requestId,
      cache: "disabled",
      resolvedPath,
      bytes,
      mtimeMs,
    });

    try {
      const digestSha256 = await this.computeDigestSha256(resolvedPath);
      this.logDigestComputation({
        requestId: input.requestId,
        resolvedPath,
        bytes,
        elapsedMs: this.now() - digestStartedAt,
      });

      return {
        resolvedPath,
        bytes,
        mtimeMs,
        digestSha256,
      };
    } catch (error) {
      this.logDigestFailure({
        requestId: input.requestId,
        resolvedPath,
        reason: toErrorMessage(error),
      });
      return {
        resolvedPath,
        bytes,
        mtimeMs,
        digestSha256: null,
        unavailableReason: "MODEL_DIGEST_UNAVAILABLE_HASH_FAILED",
      };
    }
  }

  private async computeDigestSha256(path: string): Promise<string> {
    const hash = createHash("sha256");
    const stream = createReadStream(path);

    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }

    return hash.digest("hex");
  }

  private enforceCacheBudget(): void {
    while (this.digestCache.size > this.maxEntries) {
      const oldestKey = this.digestCache.keys().next().value;
      if (!oldestKey) {
        break;
      }

      this.digestCache.delete(oldestKey);
    }
  }

  private logCacheEvent(input: {
    requestId: string | undefined;
    cache: "hit" | "miss" | "inflight" | "disabled";
    resolvedPath: string;
    bytes: number;
    mtimeMs: number;
  }): void {
    this.logger.info(
      `[chimera-bench]` +
        (input.requestId ? ` requestId=${sanitizeControlCharacters(input.requestId)}` : "") +
        ` event=model.digest.cache cache=${input.cache}` +
        ` resolvedPath=${sanitizeControlCharacters(input.resolvedPath)}` +
        ` bytes=${input.bytes}` +
        ` mtimeMs=${Math.trunc(input.mtimeMs)}`,
    );
  }

  private logDigestComputation(input: {
    requestId: string | undefined;
    resolvedPath: string;
    bytes: number;
    elapsedMs: number;
  }): void {
    this.logger.info(
      `[chimera-bench]` +
        (input.requestId ? ` requestId=${sanitizeControlCharacters(input.requestId)}` : "") +
        " event=model.digest.computed" +
        ` resolvedPath=${sanitizeControlCharacters(input.resolvedPath)}` +
        ` bytes=${input.bytes}` +
        ` elapsedMs=${Math.max(0, Math.floor(input.elapsedMs))}`,
    );
  }

  private logDigestFailure(input: {
    requestId: string | undefined;
    resolvedPath: string;
    reason: string;
  }): void {
    this.logger.error(
      `[chimera-bench]` +
        (input.requestId ? ` requestId=${sanitizeControlCharacters(input.requestId)}` : "") +
        " event=model.digest.failed" +
        ` resolvedPath=${sanitizeControlCharacters(input.resolvedPath)}` +
        ` reason=${sanitizeControlCharacters(input.reason)}`,
    );
  }
}

function buildDigestCacheKey(path: string, bytes: number, mtimeMs: number): string {
  return `${path}\n${bytes}\n${mtimeMs}`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
