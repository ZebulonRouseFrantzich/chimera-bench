import type { Hono } from "hono";
import { jsonSuccess } from "../api/envelope.ts";
import { createSseResponse } from "../sse/sse-response.ts";
import type { RuntimeControl } from "../runtime-control.ts";

interface RegisterGlobalRoutesOptions {
  version: string;
  openApiDocument: object;
  runtime: RuntimeControl;
}

export function registerGlobalRoutes(
  app: Hono,
  options: RegisterGlobalRoutesOptions,
): void {
  app.get("/global/health", (context) => {
    return jsonSuccess(context, {
      healthy: true,
      version: options.version,
    });
  });

  app.get("/doc", (context) => {
    // Intentionally return raw OpenAPI JSON rather than the API envelope.
    return context.json(options.openApiDocument);
  });

  app.get("/event", (context) => {
    return createSseResponse(context, {
      runtime: options.runtime,
      connectedEvent: "server.connected",
      heartbeatEvent: "server.heartbeat",
      disconnectedEvent: "server.disconnected",
      payloadBase: {},
    });
  });
}
