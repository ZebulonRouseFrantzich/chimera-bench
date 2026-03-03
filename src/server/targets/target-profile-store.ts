/**
 * Filesystem-backed target profile persistence.
 *
 * This module validates profile payloads, enforces path safety and permissions,
 * and uses atomic write patterns for durable updates.
 */
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { ZodError } from "zod";
import {
  type TargetProfile,
  TargetProfileSchema,
} from "./target-profile.ts";

const TARGET_PROFILES_DIRECTORY_NAME = ".chimera-bench";
const TARGET_PROFILES_SUBDIRECTORY_NAME = "targets";
const TARGET_PROFILES_DIRECTORY_MODE = 0o700;
const TARGET_PROFILE_FILE_MODE = 0o600;

export const DEFAULT_TARGET_PROFILES_ROOT_DIR = join(
  homedir(),
  TARGET_PROFILES_DIRECTORY_NAME,
  TARGET_PROFILES_SUBDIRECTORY_NAME,
);

export class TargetProfileNotFoundError extends Error {
  constructor(profileId: string) {
    super(`Target profile '${profileId}' was not found.`);
    this.name = "TargetProfileNotFoundError";
  }
}

export class TargetProfilePersistError extends Error {
  readonly logReason: string;

  constructor(message: string, logReason: string = message) {
    super(message);
    this.name = "TargetProfilePersistError";
    this.logReason = logReason;
  }
}

export class TargetProfileDeleteError extends Error {
  readonly logReason: string;

  constructor(message: string, logReason: string = message) {
    super(message);
    this.name = "TargetProfileDeleteError";
    this.logReason = logReason;
  }
}

export class TargetProfileStore {
  private readonly rootDir: string;

  constructor(rootDir: string = DEFAULT_TARGET_PROFILES_ROOT_DIR) {
    this.rootDir = resolve(rootDir);
  }

  async listProfiles(): Promise<TargetProfile[]> {
    await this.ensureStorageDirectory();

    let entries: Dirent<string>[];
    try {
      entries = await readdir(this.rootDir, {
        withFileTypes: true,
        encoding: "utf8",
      });
    } catch (error) {
      throw buildPersistError(
        "Failed to list target profile files.",
        this.rootDir,
        error,
      );
    }

    const profiles: TargetProfile[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const profileId = entry.name.slice(0, -".json".length);
      if (profileId.length === 0) {
        continue;
      }

      const profilePath = this.resolveProfilePath(profileId, "read");
      try {
        const profile = await this.readProfileFromFile(profileId, profilePath);
        profiles.push(profile);
      } catch (error) {
        if (
          error instanceof TargetProfileNotFoundError ||
          error instanceof TargetProfilePersistError
        ) {
          continue;
        }

        throw error;
      }
    }

    profiles.sort((left, right) => left.id.localeCompare(right.id));
    return profiles;
  }

  async getProfile(profileId: string): Promise<TargetProfile> {
    await this.ensureStorageDirectory();
    const profilePath = this.resolveProfilePath(profileId, "read");
    return this.readProfileFromFile(profileId, profilePath);
  }

  async upsertProfile(profile: TargetProfile): Promise<"created" | "updated"> {
    await this.ensureStorageDirectory();

    const profilePath = this.resolveProfilePath(profile.id, "write");
    // This existence check is best-effort for 200/201 mapping.
    // Concurrent updates are still safely handled with last-write-wins semantics.
    const existed = await this.profileFileExists(profile.id);
    const serializedProfile = `${JSON.stringify(profile, null, 2)}\n`;

    await this.writeProfileFileAtomic(profilePath, serializedProfile);
    return existed ? "updated" : "created";
  }

  async deleteProfile(profileId: string): Promise<void> {
    await this.ensureStorageDirectory();

    const profilePath = this.resolveProfilePath(profileId, "delete");

    try {
      await rm(profilePath);
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        throw new TargetProfileNotFoundError(profileId);
      }

      throw buildDeleteError(
        `Failed to delete target profile '${profileId}'.`,
        profilePath,
        error,
      );
    }
  }

  private async profileFileExists(profileId: string): Promise<boolean> {
    const profilePath = this.resolveProfilePath(profileId, "read");

    try {
      const profileStats = await stat(profilePath);
      return profileStats.isFile();
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        return false;
      }

      throw buildPersistError(
        `Failed to check existing target profile '${profileId}'.`,
        profilePath,
        error,
      );
    }
  }

  private async readProfileFromFile(
    profileId: string,
    profilePath: string,
  ): Promise<TargetProfile> {
    let serializedProfile: string;

    try {
      serializedProfile = await readFile(profilePath, "utf8");
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        throw new TargetProfileNotFoundError(profileId);
      }

      throw buildPersistError(
        `Failed to read target profile '${profileId}'.`,
        profilePath,
        error,
      );
    }

    let parsedProfile: unknown;

    try {
      parsedProfile = JSON.parse(serializedProfile) as unknown;
    } catch (error) {
      throw buildPersistError(
        `Stored target profile '${profileId}' is not valid JSON.`,
        profilePath,
        error,
      );
    }

    const validatedProfile = TargetProfileSchema.safeParse(parsedProfile);
    if (!validatedProfile.success) {
      throw buildPersistError(
        `Stored target profile '${profileId}' did not match the expected schema.`,
        profilePath,
        validatedProfile.error,
      );
    }

    if (validatedProfile.data.id !== profileId) {
      throw buildPersistError(
        `Stored target profile '${profileId}' does not match the expected id.`,
        profilePath,
      );
    }

    return validatedProfile.data;
  }

  private async writeProfileFileAtomic(
    profilePath: string,
    serializedProfile: string,
  ): Promise<void> {
    const tempPath = `${profilePath}.tmp-${randomUUID()}`;
    if (!isPathWithinRoot(tempPath, this.rootDir)) {
      throw new TargetProfilePersistError(
        "Failed to persist target profile.",
        `Temporary profile path '${tempPath}' resolved outside root '${this.rootDir}'.`,
      );
    }

    try {
      await writeFile(tempPath, serializedProfile, {
        encoding: "utf8",
        flag: "wx",
        mode: TARGET_PROFILE_FILE_MODE,
      });
      await chmod(tempPath, TARGET_PROFILE_FILE_MODE);
      await rename(tempPath, profilePath);
      await chmod(profilePath, TARGET_PROFILE_FILE_MODE);
    } catch (error) {
      try {
        await rm(tempPath, {
          force: true,
        });
      } catch {
        // Best effort cleanup for failed atomic writes.
      }

      throw buildPersistError("Failed to persist target profile.", profilePath, error);
    }
  }

  private async ensureStorageDirectory(): Promise<void> {
    try {
      await mkdir(this.rootDir, {
        recursive: true,
        mode: TARGET_PROFILES_DIRECTORY_MODE,
      });

      const parentDirectory = dirname(this.rootDir);
      if (basename(parentDirectory) === TARGET_PROFILES_DIRECTORY_NAME) {
        await chmod(parentDirectory, TARGET_PROFILES_DIRECTORY_MODE);
      }

      await chmod(this.rootDir, TARGET_PROFILES_DIRECTORY_MODE);
    } catch (error) {
      throw buildPersistError(
        "Failed to prepare target profile storage directory.",
        this.rootDir,
        error,
      );
    }
  }

  private resolveProfilePath(
    profileId: string,
    operation: "read" | "write" | "delete",
  ): string {
    const path = resolve(this.rootDir, `${profileId}.json`);

    if (isPathWithinRoot(path, this.rootDir)) {
      return path;
    }

    const message = `Target profile '${profileId}' resolves outside storage root.`;

    if (operation === "delete") {
      throw new TargetProfileDeleteError(
        message,
        `Target profile '${profileId}' resolved outside root '${this.rootDir}'.`,
      );
    }

    throw new TargetProfilePersistError(
      message,
      `Target profile '${profileId}' resolved outside root '${this.rootDir}'.`,
    );
  }
}

function buildPersistError(
  message: string,
  path: string,
  error?: unknown,
): TargetProfilePersistError {
  const code = getNodeErrorCode(error);
  const safeMessage = code ? `${message} Filesystem error (${code}).` : message;

  return new TargetProfilePersistError(
    safeMessage,
    `${message} path='${path}' reason='${formatErrorReason(error)}'`,
  );
}

function buildDeleteError(
  message: string,
  path: string,
  error?: unknown,
): TargetProfileDeleteError {
  const code = getNodeErrorCode(error);
  const safeMessage = code ? `${message} Filesystem error (${code}).` : message;

  return new TargetProfileDeleteError(
    safeMessage,
    `${message} path='${path}' reason='${formatErrorReason(error)}'`,
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

function formatErrorReason(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => issue.message).join("; ");
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (error === undefined) {
    return "unknown";
  }

  return String(error);
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

function isPathWithinRoot(path: string, rootDir: string): boolean {
  if (path === rootDir) {
    return true;
  }

  const normalizedRootWithSeparator =
    rootDir.endsWith(sep) ? rootDir : `${rootDir}${sep}`;
  return path.startsWith(normalizedRootWithSeparator);
}
