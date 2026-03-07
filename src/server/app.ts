import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { getOrCreateRequestId, jsonError, setRequestId } from "./api/envelope.ts";
import { createOpenApiDocument } from "./api/openapi/index.ts";
import { createEngineCatalog } from "./engines/engine-catalog.ts";
import type { EngineCatalog } from "./engines/engine-catalog.ts";
import { createStarterLlamaCppPlugin } from "./engines/starter-engine/index.ts";
import { sanitizeControlCharacters } from "./http/sanitize.ts";
import {
  DEFAULT_SERVER_LOGGER,
  type ServerLogger,
} from "./logging.ts";
import { corsAllowlistMiddleware } from "./middleware/cors-allowlist.ts";
import { basicAuthMiddleware } from "./middleware/basic-auth.ts";
import { registerEngineRoutes } from "./routes/engine-routes.ts";
import type { EngineEnvironmentValidationSettings } from "./routes/engine-routes.ts";
import { registerGlobalRoutes } from "./routes/global-routes.ts";
import { registerRunRoutes } from "./routes/run-routes/index.ts";
import { registerTargetRoutes } from "./routes/target-routes.ts";
import { registerWorkloadRoutes } from "./routes/workload-routes.ts";
import {
  DEFAULT_RUN_ARTIFACTS_ROOT_DIR,
  RunArtifactStore,
} from "./runs/run-artifact-store.ts";
import { InMemoryRunStore } from "./runs/in-memory-run-store/index.ts";
import { ModelDigestService } from "./runs/model-digest-service.ts";
import { TargetProfileStore } from "./targets/target-profile-store.ts";
import { WorkloadRegistry } from "./workloads/registry.ts";
import type { RuntimeControl } from "./runtime-control.ts";
import type { BasicAuthSettings } from "./types.ts";

interface AppOptions {
  version: string;
  auth: BasicAuthSettings;
  corsAllowlist: string[];
  runtime: RuntimeControl;
  devMode?: boolean;
  logger?: ServerLogger;
  modelRoots?: string[];
  workloadRoots?: string[];
  modelDigestCacheMaxEntries?: number;
  engines?: EngineCatalog;
  engineEnvironmentValidation?: EngineEnvironmentValidationSettings;
  runArtifactsRootDir?: string;
  targetProfilesRootDir?: string;
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  const logger = options.logger ?? DEFAULT_SERVER_LOGGER;
  const openApiDocument = createOpenApiDocument();
  const targetProfiles = new TargetProfileStore(options.targetProfilesRootDir);
  const engines =
    options.engines ?? createDefaultEngineCatalog(options.modelRoots ?? [], targetProfiles);
  const runStore = new InMemoryRunStore();
  const runArtifacts = new RunArtifactStore(
    options.runArtifactsRootDir ?? DEFAULT_RUN_ARTIFACTS_ROOT_DIR,
  );
  const modelDigests = new ModelDigestService({
    logger,
    ...(typeof options.modelDigestCacheMaxEntries === "number"
      ? {
          maxEntries: options.modelDigestCacheMaxEntries,
        }
      : {}),
  });
  const workloads = new WorkloadRegistry({
    workloadRoots: options.workloadRoots ?? [],
    logger,
  });

  app.use("*", async (context, next) => {
    const requestId = randomUUID();
    setRequestId(context, requestId);

    await next();

    context.header("X-Request-Id", requestId);
  });

  if (options.devMode) {
    app.use("*", async (context, next) => {
      const requestId = getOrCreateRequestId(context);
      const startedAt = Date.now();

      try {
        await next();
      } finally {
        const durationMs = Math.max(0, Date.now() - startedAt);
        const method = sanitizeControlCharacters(context.req.method);
        const path = sanitizeControlCharacters(context.req.path);
        const status = context.res.status;

        logger.info(
          `[chimera-bench] requestId=${requestId} method="${method}" path="${path}" status=${status} durationMs=${durationMs}`,
        );
      }
    });
  }

  if (options.corsAllowlist.length > 0) {
    app.use("*", corsAllowlistMiddleware(options.corsAllowlist));
  }

  app.use("*", basicAuthMiddleware(options.auth));

  registerGlobalRoutes(app, {
    version: options.version,
    openApiDocument,
    runtime: options.runtime,
  });
  registerEngineRoutes(app, {
    engines,
    ...(options.engineEnvironmentValidation
      ? {
          environmentValidation: options.engineEnvironmentValidation,
        }
      : {}),
  });
  registerTargetRoutes(app, {
    targetProfiles,
    logger,
  });
  registerWorkloadRoutes(app, {
    workloads,
    logger,
  });
  registerRunRoutes(app, {
    version: options.version,
    runtime: options.runtime,
    runStore,
    runArtifacts,
    targetProfiles,
    workloads,
    modelDigests,
    engines,
    logger,
  });

  app.onError((error, context) => {
    const requestId = getOrCreateRequestId(context);
    const method = sanitizeControlCharacters(context.req.method);
    const path = sanitizeControlCharacters(context.req.path);
    const safeErrorMessage = sanitizeControlCharacters(error.message);
    logger.error(
      `[chimera-bench] requestId=${requestId} method="${method}" path="${path}" error="${safeErrorMessage}"`,
    );

    return jsonError(context, 500, {
      code: "INTERNAL_ERROR",
      message: "An unexpected server error occurred.",
    });
  });

  app.notFound((context) => {
    return jsonError(context, 404, {
      code: "NOT_FOUND",
      message: "Route not found.",
    });
  });

  return app;
}

function createDefaultEngineCatalog(
  modelRoots: string[],
  targetProfiles: TargetProfileStore,
): EngineCatalog {
  return createEngineCatalog([
    createStarterLlamaCppPlugin({
      modelRoots,
      getTargetProfile: async (profileId: string) => {
        return await targetProfiles.getProfile(profileId);
      },
    }),
  ]);
}
