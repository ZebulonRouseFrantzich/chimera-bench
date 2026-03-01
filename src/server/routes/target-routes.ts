import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import type { Context } from "hono";
import type { Hono } from "hono";
import { z } from "zod";
import {
  getOrCreateRequestId,
  jsonError,
  jsonSuccess,
} from "../api/envelope.ts";
import { parseJsonBody } from "../http/request-validation.ts";
import { sanitizeControlCharacters } from "../http/sanitize.ts";
import { formatValidationIssues } from "../http/validation-issues.ts";
import {
  DEFAULT_SERVER_LOGGER,
  type ServerLogger,
} from "../logging.ts";
import {
  type TargetProfile,
  TargetProfileIdSchema,
  TargetProfileSchema,
} from "../targets/target-profile.ts";
import {
  TargetProfileDeleteError,
  TargetProfileNotFoundError,
  TargetProfilePersistError,
  type TargetProfileStore,
} from "../targets/target-profile-store.ts";

const TARGET_PROFILE_BODY_LIMIT_BYTES = 32 * 1024;
const PRIVATE_KEY_ROOT_DIR = resolve(homedir(), ".ssh");

const TargetProfileIdParamsSchema = z.object({
  id: TargetProfileIdSchema,
});

interface RegisterTargetRoutesOptions {
  targetProfiles: TargetProfileStore;
  logger?: ServerLogger;
}

export function registerTargetRoutes(
  app: Hono,
  options: RegisterTargetRoutesOptions,
): void {
  const logger = options.logger ?? DEFAULT_SERVER_LOGGER;

  app.get("/targets", async (context) => {
    try {
      const profiles = await options.targetProfiles.listProfiles();

      return jsonSuccess(context, {
        profiles,
      });
    } catch (error) {
      if (error instanceof TargetProfilePersistError) {
        logTargetProfileError(context, logger, "list", error);
        return jsonError(context, 500, {
          code: "TARGET_PROFILE_PERSIST_FAILED",
          message: "Failed to load target profiles.",
        });
      }

      throw error;
    }
  });

  app.post("/targets", async (context) => {
    const parsedProfile = await parseTargetProfileBody(context);
    if (parsedProfile instanceof Response) {
      return parsedProfile;
    }

    try {
      const operation = await options.targetProfiles.upsertProfile(parsedProfile);
      const status = operation === "created" ? 201 : 200;

      return jsonSuccess(
        context,
        {
          profile: parsedProfile,
        },
        status,
      );
    } catch (error) {
      if (error instanceof TargetProfilePersistError) {
        logTargetProfileError(context, logger, "upsert", error, parsedProfile.id);
        return jsonError(context, 500, {
          code: "TARGET_PROFILE_PERSIST_FAILED",
          message: "Failed to persist target profile.",
        });
      }

      throw error;
    }
  });

  app.get("/targets/:id", async (context) => {
    const profileId = parseTargetProfileIdParam(context);
    if (profileId instanceof Response) {
      return profileId;
    }

    try {
      const profile = await options.targetProfiles.getProfile(profileId);

      return jsonSuccess(context, {
        profile,
      });
    } catch (error) {
      if (error instanceof TargetProfileNotFoundError) {
        return jsonError(context, 404, {
          code: "TARGET_PROFILE_NOT_FOUND",
          message: `Target profile '${sanitizeControlCharacters(profileId)}' was not found.`,
        });
      }

      if (error instanceof TargetProfilePersistError) {
        logTargetProfileError(context, logger, "get", error, profileId);
        return jsonError(context, 500, {
          code: "TARGET_PROFILE_PERSIST_FAILED",
          message: "Failed to load target profile.",
        });
      }

      throw error;
    }
  });

  app.delete("/targets/:id", async (context) => {
    const profileId = parseTargetProfileIdParam(context);
    if (profileId instanceof Response) {
      return profileId;
    }

    try {
      await options.targetProfiles.deleteProfile(profileId);

      return jsonSuccess(context, {
        id: profileId,
      });
    } catch (error) {
      if (error instanceof TargetProfileNotFoundError) {
        return jsonError(context, 404, {
          code: "TARGET_PROFILE_NOT_FOUND",
          message: `Target profile '${sanitizeControlCharacters(profileId)}' was not found.`,
        });
      }

      if (error instanceof TargetProfileDeleteError) {
        logTargetProfileError(context, logger, "delete", error, profileId);
        return jsonError(context, 500, {
          code: "TARGET_PROFILE_DELETE_FAILED",
          message: "Failed to delete target profile.",
        });
      }

      throw error;
    }
  });
}

async function parseTargetProfileBody(
  context: Context,
): Promise<TargetProfile | Response> {
  const parsedBody = await parseJsonBody(context, z.unknown(), TARGET_PROFILE_BODY_LIMIT_BYTES);
  if (parsedBody instanceof Response) {
    return parsedBody;
  }

  const parsedProfile = TargetProfileSchema.safeParse(parsedBody);
  if (!parsedProfile.success) {
    return jsonError(context, 400, {
      code: "VALIDATION_TARGET_PROFILE_INVALID",
      message: "Target profile request body is invalid.",
      details: {
        issues: formatValidationIssues(parsedProfile.error.issues),
      },
    });
  }

  const keyPathIssues = await validatePrivateKeyPath(parsedProfile.data);
  if (keyPathIssues.length > 0) {
    return jsonError(context, 400, {
      code: "VALIDATION_TARGET_PROFILE_INVALID",
      message: "Target profile request body is invalid.",
      details: {
        issues: keyPathIssues,
      },
    });
  }

  return parsedProfile.data;
}

function parseTargetProfileIdParam(context: Context): string | Response {
  const parsed = TargetProfileIdParamsSchema.safeParse({
    id: context.req.param("id"),
  });

  if (!parsed.success) {
    return jsonError(context, 400, {
      code: "VALIDATION_TARGET_PROFILE_INVALID",
      message: "Target profile path parameter is invalid.",
      details: {
        issues: formatValidationIssues(parsed.error.issues),
      },
    });
  }

  return parsed.data.id;
}

async function validatePrivateKeyPath(
  profile: TargetProfile,
): Promise<
  Array<{
    code: string;
    message: string;
    path: string;
  }>
> {
  if (profile.auth.method !== "key-path") {
    return [];
  }

  const privateKeyPath = resolve(profile.auth.privateKeyPath);
  if (!isPathWithinRoot(privateKeyPath, PRIVATE_KEY_ROOT_DIR)) {
    return [createPrivateKeyPathIssue()];
  }

  let keyPathStat: Awaited<ReturnType<typeof stat>>;

  try {
    keyPathStat = await stat(privateKeyPath);
  } catch {
    return [createPrivateKeyPathIssue()];
  }

  if (!keyPathStat.isFile()) {
    return [createPrivateKeyPathIssue()];
  }

  try {
    await access(privateKeyPath, fsConstants.R_OK);
  } catch {
    return [createPrivateKeyPathIssue()];
  }

  return [];
}

function createPrivateKeyPathIssue(): {
  code: string;
  message: string;
  path: string;
} {
  return {
    code: "custom",
    message:
      "auth.privateKeyPath must reference an existing readable file under ~/.ssh.",
    path: "auth.privateKeyPath",
  };
}

function logTargetProfileError(
  context: Context,
  logger: ServerLogger,
  operation: "list" | "upsert" | "get" | "delete",
  error: TargetProfilePersistError | TargetProfileDeleteError,
  profileId?: string,
): void {
  const requestId = getOrCreateRequestId(context);
  const sanitizedReason = sanitizeControlCharacters(error.logReason);

  logger.error(
    `[chimera-bench] requestId=${requestId} targetProfileOperation=${operation}` +
      (profileId ? ` profileId=${sanitizeControlCharacters(profileId)}` : "") +
      ` reason=${sanitizedReason}`,
  );
}

function isPathWithinRoot(path: string, rootDir: string): boolean {
  if (path === rootDir) {
    return true;
  }

  const normalizedRootWithSeparator =
    rootDir.endsWith(sep) ? rootDir : `${rootDir}${sep}`;
  return path.startsWith(normalizedRootWithSeparator);
}
