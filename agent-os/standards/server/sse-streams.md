# SSE Streams

For any SSE endpoint:

- Use `createSseResponse()` from `src/server/sse/sse-response.ts`.
- Always emit lifecycle events:
  - `*.connected` on open
  - `*.heartbeat` every 15s
  - `*.disconnected` before close
- SSE `data:` payload is always a JSON object and always includes:
  - `timestamp` (ISO string)
  - any `payloadBase` fields (example: `runId`)
- Set standard SSE headers and include `X-Request-Id`.

Shutdown + cleanup:

- Register each stream with `RuntimeControl.registerSseStream()`.
- On shutdown, server calls `RuntimeControl.closeSseStreams(reason)`.
- Close on client disconnect via request abort signal.

Replay + terminal close:

- Support `replayEvents` on connect for catch-up.
- Use `shouldCloseAfterEvent` for terminal events (example: `run.completed|run.failed|run.cancelled`).
