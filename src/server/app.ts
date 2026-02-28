import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { getOrCreateRequestId, jsonError, setRequestId } from "./api/envelope.ts";
import { createOpenApiDocument } from "./api/openapi.ts";
import { corsAllowlistMiddleware } from "./middleware/cors-allowlist.ts";
import { basicAuthMiddleware } from "./middleware/basic-auth.ts";
import { registerEngineRoutes } from "./routes/engine-routes.ts";
import { registerGlobalRoutes } from "./routes/global-routes.ts";
import { registerRunRoutes } from "./routes/run-routes.ts";
import { InMemoryRunStore } from "./runs/in-memory-run-store.ts";
import type { RuntimeControl } from "./runtime-control.ts";
import type { BasicAuthSettings } from "./types.ts";

interface AppOptions {
  version: string;
  auth: BasicAuthSettings;
  corsAllowlist: string[];
  runtime: RuntimeControl;
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  const openApiDocument = createOpenApiDocument({
    version: options.version,
  });
  const runStore = new InMemoryRunStore();

  app.use("*", async (context, next) => {
    const requestId = randomUUID();
    setRequestId(context, requestId);

    await next();

    context.header("X-Request-Id", requestId);
  });

  if (options.corsAllowlist.length > 0) {
    app.use("*", corsAllowlistMiddleware(options.corsAllowlist));
  }

  app.use("*", basicAuthMiddleware(options.auth));

  registerGlobalRoutes(app, {
    version: options.version,
    openApiDocument,
    runtime: options.runtime,
  });
  registerEngineRoutes(app);
  registerRunRoutes(app, {
    runtime: options.runtime,
    runStore,
  });

  app.onError((error, context) => {
    const requestId = getOrCreateRequestId(context);
    console.error(
      `[chimera-bench] requestId=${requestId} method=${context.req.method} path=${context.req.path} error=${error.message}`,
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
