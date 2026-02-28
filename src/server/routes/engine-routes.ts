import type { Hono } from "hono";
import { jsonSuccess } from "../api/envelope.ts";
import { STARTER_ENGINE_SUMMARY } from "../engines/starter-engine.ts";

export function registerEngineRoutes(app: Hono): void {
  app.get("/engines", (context) => {
    return jsonSuccess(context, {
      engines: [STARTER_ENGINE_SUMMARY],
    });
  });
}
