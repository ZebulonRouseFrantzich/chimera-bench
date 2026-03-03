# Sweep Engine Run Orchestration

## Objective

Automate benchmark matrices across engine flags, API params, and context depth with reproducible run control.

## Context carried from shaping

- Sweep definitions must preserve flexibility for evolving engine flags.
- Pass-through options are required so new backend flags can be tested without core schema churn.
- Engine restarts between cases are required to reduce cache contamination and improve comparability.

## Deliverables

- Sweep definition schema (axes, value sets, combinatorics controls).
- Deterministic case generation and run ordering.
- Case runner with clean engine restarts between cases to avoid cache contamination.
- Progress tracking and resumable run state.
- Typed progress events over `/event` for clients monitoring long-running sweeps.
- Aggregated run summary statistics.

## Standards applied

- `agent-os/standards/server/api-conventions.md`
- `agent-os/standards/plugins/engine-interface.md`
- `agent-os/standards/runs/result-schema.md`

## Reference implementations

- See `references.md`.

## Non-goals

- SSH execution.
- Advanced log metrics parsing (handled in a later spec).
- Frontend UI work.

## Implementation tasks

1. Define sweep config model for engine args, request params, and workload selection.
   - Extend the run creation schema to support an optional `sweep` object.
   - `sweep` fields (initial):
     - `axes.serverArgs` (object: axis name -> list of values)
     - `axes.requestParams` (object: param key -> list of values)
     - `promptSelection` (optional: promptIds subset)
     - `repetitions` (optional; default `1`)
     - `seed` (optional; used for deterministic sampling)
     - `maxCases` (optional; hard cap to prevent combinatorial explosions)
   - Validation rules:
     - Reject empty axes (sweep must produce at least 1 case).
     - Enforce `maxCases` and return a stable `VALIDATION_SWEEP_TOO_LARGE` error when exceeded.
   - Manual testing steps:
     - Submit a sweep run with a tiny 2x2 axis and verify it is accepted.
     - Submit an oversized sweep and verify a 4xx validation error.

2. Build deterministic matrix expansion and case identity hashing.
   - Deterministic expansion rules:
     - Sort axis keys.
     - Preserve input value order (or sort explicitly; pick one and document it).
     - Combine axes with a cartesian product, then apply `repetitions`.
   - Case identity:
     - Compute `caseId` as a hash of a canonical JSON representation of the case config.
     - Include all fields that impact inference (`engineArgs`, `requestParams`, `promptId`, context, model identifier).
   - Manual testing steps:
     - Unit test: same sweep config produces identical case ordering and `caseId`s across runs.

3. Implement sweep scheduler and restart policy.
   - Execution model:
     - Run cases sequentially (single active sweep per server process initially).
     - Restart the engine between cases (start -> ready -> execute -> collect -> stop per case).
   - Failure handling:
     - Record per-case errors and continue when possible.
     - If the engine cannot start repeatedly, fail the run with a stable `ENGINE_*` error.
   - Manual testing steps:
     - Run a 2x2 sweep and confirm `result.json` contains 4 cases.
     - Verify engine restarts occur between cases (e.g., observe different ports / PIDs in logs).

4. Define and emit typed sweep progress events.
   - Emit progress over:
     - global `/event` (server-wide)
     - per-run `/runs/:runId/event`
   - Event types (initial):
     - `sweep.created`, `sweep.started`, `sweep.case.started`, `sweep.case.completed`, `sweep.case.failed`, `sweep.completed`, `sweep.failed`, `sweep.cancelled`
   - Include `runId`, `caseId`, `index`, and `{ completedCases, totalCases }` in payloads.
   - Manual testing steps:
     - Connect: `curl -N -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/event`
     - Start a sweep and confirm events are emitted.

5. Persist intermediate state for resume/cancel behavior.
   - Persist a state file under the run directory (example: `runs/{runId}/state.json`).
   - Contents include:
     - sweep config
     - expanded cases list (or a deterministic seed + cursor)
     - current cursor/index and per-case status
   - Resume:
     - Add `POST /runs/:runId/resume` (idempotent) to continue from the persisted cursor.
   - Manual testing steps:
     - Start a sweep; stop the server mid-run; restart the server.
     - Call `POST /runs/RUN_ID/resume` and confirm it continues where it left off.

6. Generate aggregate summaries over case outputs.
   - Aggregate summary fields:
     - counts by status
     - latency/throughput aggregates (mean/median/p95)
     - best/worst configurations by tokens/sec
   - Persist aggregates in `result.json` (under a `summary` object) and ensure exports reflect them.
   - Manual testing steps:
     - Complete a sweep; open `runs/RUN_ID/summary.md` and confirm it contains sweep-level aggregates.

## Exit criteria

- A single command/API call runs a full parameter sweep with deterministic artifacts and restart isolation.

## Dependencies

- Requires `server-plugin-llama-cpp-foundation` and `workload-packs-and-exports`.
