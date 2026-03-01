# Run Orchestration: Cancellation and Timeouts

Core orchestration owns timeouts, cancellation, engine lifecycle, and persistence.

Timeouts:

- Enforce a run-level deadline (`runMs`) and a per-case timeout (`caseMs`).
- Use `AbortController` for the run and pass `abortSignal` into engine calls.
- For each case, create a child abort controller linked to the run abort signal.
- On timeout, abort and request engine stop.

Cancellation:

- Register an active-run canceller via `RuntimeControl.setActiveRunCanceller()`.
- Cancellation aborts the run and requests engine stop.
- Treat `AbortError` as cancellation.

Failure semantics:

- `ENGINE_*` errors are fatal:
  - fail remaining cases with the same failure
  - set `run.status="failed"`
- Non-fatal case errors:
  - record the case as failed and continue
  - `run.status="completed"` can include per-case failures

Cleanup + persistence:

- Always attempt `plugin.stop()` in `finally` with a bounded timeout.
- Persist `runs/{runId}/result.json` for all terminal outcomes (`completed`, `failed`, `cancelled`).
