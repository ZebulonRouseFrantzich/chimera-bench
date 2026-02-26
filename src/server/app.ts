import { Hono } from "hono";
import { basicAuthMiddleware } from "./middleware/basic-auth.ts";
import { corsAllowlistMiddleware } from "./middleware/cors-allowlist.ts";
import type { RuntimeControl } from "./runtime-control.ts";
import type { BasicAuthSettings } from "./types.ts";

interface AppOptions {
  version: string;
  auth: BasicAuthSettings;
  corsAllowlist: string[];
  runtime: RuntimeControl;
}

const HEARTBEAT_INTERVAL_MS = 15000;
const SSE_ENCODER = new TextEncoder();

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  if (options.corsAllowlist.length > 0) {
    app.use("*", corsAllowlistMiddleware(options.corsAllowlist));
  }

  app.use("*", basicAuthMiddleware(options.auth));

  app.get("/global/health", (context) => {
    return context.json({
      healthy: true,
      version: options.version,
    });
  });

  app.get("/event", (context) => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let unregisterSseStream: (() => void) | null = null;
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const enqueueEvent = (event: string, payload: Record<string, unknown>): void => {
      if (!streamController) {
        return;
      }

      try {
        streamController.enqueue(
          SSE_ENCODER.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
        );
      } catch {
        // Stream is already closed or cancelled.
      }
    };

    const pushEvent = (event: string, payload: Record<string, unknown>): void => {
      if (!streamController || closed) {
        return;
      }

      enqueueEvent(event, payload);
    };

    const closeStream = (reason: string): void => {
      if (closed) {
        return;
      }

      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
      }

      enqueueEvent("server.disconnected", {
        reason,
        timestamp: new Date().toISOString(),
      });

      closed = true;

      if (streamController) {
        try {
          streamController.close();
        } catch {
          // Stream is already closed or cancelled.
        }
      }

      if (unregisterSseStream) {
        unregisterSseStream();
        unregisterSseStream = null;
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        pushEvent("server.connected", {
          timestamp: new Date().toISOString(),
        });

        heartbeatInterval = setInterval(() => {
          pushEvent("server.heartbeat", {
            timestamp: new Date().toISOString(),
          });
        }, HEARTBEAT_INTERVAL_MS);

        unregisterSseStream = options.runtime.registerSseStream({
          close: closeStream,
        });
      },
      cancel() {
        closeStream("client-disconnect");
      },
    });

    context.req.raw.signal.addEventListener(
      "abort",
      () => {
        closeStream("client-disconnect");
      },
      { once: true },
    );

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  app.notFound((context) => {
    return context.json({
      success: false,
      error: {
        code: "NOT_FOUND",
        message: "Route not found.",
      },
    }, 404);
  });

  return app;
}
