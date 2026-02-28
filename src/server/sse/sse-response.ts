import type { Context } from "hono";
import { getOrCreateRequestId } from "../api/envelope.ts";
import type { RuntimeControl } from "../runtime-control.ts";

const HEARTBEAT_INTERVAL_MS = 15000;
const SSE_ENCODER = new TextEncoder();

export interface SseResponseOptions {
  runtime: RuntimeControl;
  connectedEvent: string;
  heartbeatEvent: string;
  disconnectedEvent: string;
  payloadBase: Record<string, unknown>;
}

export function createSseResponse(context: Context, input: SseResponseOptions): Response {
  const requestId = getOrCreateRequestId(context);
  const abortSignal = context.req.raw.signal;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let unregisterSseStream: (() => void) | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let abortListenerRegistered = false;
  let closed = false;

  const handleAbort = (): void => {
    closeStream("client-disconnect");
  };

  const withTimestamp = (
    payload: Record<string, unknown> = {},
  ): Record<string, unknown> => {
    return {
      ...input.payloadBase,
      ...payload,
      timestamp: new Date().toISOString(),
    };
  };

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
      heartbeatInterval = null;
    }

    enqueueEvent(
      input.disconnectedEvent,
      withTimestamp({
        reason,
      }),
    );

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

    if (abortListenerRegistered) {
      abortSignal.removeEventListener("abort", handleAbort);
      abortListenerRegistered = false;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;

      if (abortSignal.aborted) {
        closeStream("client-disconnect");
        return;
      }

      abortSignal.addEventListener("abort", handleAbort, {
        once: true,
      });
      abortListenerRegistered = true;

      if (abortSignal.aborted) {
        closeStream("client-disconnect");
        return;
      }

      pushEvent(input.connectedEvent, withTimestamp());
      if (closed) {
        return;
      }

      heartbeatInterval = setInterval(() => {
        pushEvent(input.heartbeatEvent, withTimestamp());
      }, HEARTBEAT_INTERVAL_MS);
      if (closed && heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
        return;
      }

      unregisterSseStream = input.runtime.registerSseStream({
        close: closeStream,
      });
    },
    cancel() {
      closeStream("client-disconnect");
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Request-Id": requestId,
    },
  });
}
