# Graceful Shutdown

Shutdown must be best-effort and must always stop listening.

Server stop flow:

- Call `RuntimeControl.stopAcceptingNewRuns()` first.
- Run cleanup steps in parallel (best-effort):
  - `RuntimeControl.cancelActiveRun(reason)`
  - `RuntimeControl.cleanupEngineSubprocesses(reason)`
  - `RuntimeControl.closeSseStreams(reason)`
  - stop mDNS advertisement (if enabled)
- Use `Promise.allSettled` so one failure does not block other cleanup.
- Always stop the Bun server in `finally`.

Error behavior:

- If any cleanup step rejects, `stop()` rejects (even though the server already stopped).
- Callers (CLI/tests) treat shutdown failure as an error.

Idempotency:

- Memoize an in-flight `stop()` promise so repeated stop calls share the same work.
