# Sweep MVP

## Objective

Enable a minimal, server-side sweep execution path for v0.0.1 so operators can tune `llama-server` launch args and request params against a remote machine over SSH.

## Context

- v0.0.1 uses explicit value lists for sweep axes (no `{ min, max, step }` generators yet).
- Sweeps must restart the engine between cases so launch arg changes are isolated.
- Output artifacts must be usable without a client UI (JSON is sufficient).

## Deliverables

- `POST /runs` accepts an optional `sweep` object that expands into multiple cases.
- Deterministic sweep expansion order and stable case identities.
- Engine restarts between sweep cases.
- A single `runs/{runId}/result.json` containing all cases plus a best-to-worst ranking.

## Non-goals

- Range/step axis generators.
- Resume support and intermediate state persistence.
- Dedicated sweep event taxonomy (reuse existing run events for v0.0.1 if needed).
- CSV/markdown exports.
- Frontend/dashboard UI.

## Implementation tasks

### Task 1: Finalize Spec Documentation

- Ensure this spec folder contains:
  - `plan.md`
  - `shape.md`
  - `references.md`
  - `standards.md`
  - `visuals/README.md`
- Ensure every task in `plan.md` includes a `Manual Testing Steps` section.
- Note on artifacts: the embedded run result standard mentions `cases.csv` + `summary.md`, but v0.0.1 Sweep MVP only requires `runs/{runId}/result.json`.

#### Manual Testing Steps

```bash
ls -la agent-os/specs/2026-03-03-1210-sweep-mvp/
rg -n "^### Task |^#### Manual Testing Steps" agent-os/specs/2026-03-03-1210-sweep-mvp/plan.md
```

### Task 2: Extend Run Creation Schema With Sweep Config (Explicit Lists)

Add an optional `sweep` object to `POST /runs` request bodies.

#### Request Shape

- `sweep.axes.serverArgs`: `Record<string, string[][]>`
  - Each axis key is a human label (example: `"ctxSize"`, `"gpuLayers"`).
  - Each axis value is a list of argv fragments.
  - Each argv fragment is a non-empty `string[]` that will be appended to `engine.serverArgs`.
  - Example value: `["--ctx-size", "8192"]`.

- `sweep.axes.requestParams`: `Record<string, unknown[]>`
  - Each key is a top-level request param key (example: `"max_tokens"`).
  - Each axis value is a list of JSON-serializable values.

- `sweep.repetitions`: optional integer, default `1`.
  - v0.0.1 semantics: repetitions produce multiple independent cases (no aggregation/averaging).

- `sweep.maxCases`: required integer hard cap.

#### Merge Semantics (Base Engine Options + Sweep)

- Base engine options come from `engine.serverArgs` and `engine.requestParams` and apply to every sweep case.
- For each expanded case:
  - `serverArgs`:
    - Start with the base `engine.serverArgs`.
    - Append one argv fragment from each `sweep.axes.serverArgs` axis in deterministic axis-key order.
    - If flags repeat, engine CLI semantics apply (often "last one wins").
  - `requestParams`:
    - Start with `{ ...engine.requestParams }`.
    - For each `sweep.axes.requestParams` key selected, set/override that key on the object.

#### Server-Side Hard Limits (v0.0.1)

- The server must enforce a hard upper bound on sweep size regardless of what the client requests:
  - `MAX_SWEEP_CASES = 256`
- Additional schema-level limits for early rejection:
  - `MAX_SWEEP_AXES_PER_NAMESPACE = 32`
  - `MAX_SWEEP_AXIS_VALUES = 256` per axis list
  - sweep server-arg fragment token cap matches base `engine.serverArgs` cap (`64`)
- `sweep.maxCases` must be `<= MAX_SWEEP_CASES`.
- `plannedCases` must be `<= MAX_SWEEP_CASES`.

Rationale: avoid accidental or malicious long-running sweeps (SSH restarts per case) and overly large `result.json` artifacts.

#### Validation Ordering (POST /runs)

Perform validations in an order that avoids expensive work and prevents surprising partial acceptance:

1) Parse and validate the request body shape (zod).
2) Resolve the workload (to enforce sweep workload constraints before accepting a run).
3) Validate sweep config (axes shape, JSON-only values, caps) and compute `plannedCases` without expanding the full matrix.
4) Accept the run.

#### Validation Rules

- If `sweep` is present, it must expand to at least 1 case.
- All axis lists must be non-empty.
- `sweep.maxCases` must be enforced against the planned total cases.
  - `plannedCases = (product of axis lengths across both namespaces) * repetitions`
- Reject any request where `sweep.maxCases > MAX_SWEEP_CASES` with `400` and code `VALIDATION_SWEEP_TOO_LARGE`.
  - Fast-fail precedence is intentional: return this stable ceiling error immediately even if other sweep issues exist.
- If `plannedCases > maxCases` or `plannedCases > MAX_SWEEP_CASES`, reject with `400` and code `VALIDATION_SWEEP_TOO_LARGE`.
- If `sweep` is present but axes are empty (no `serverArgs` and no `requestParams` axes), reject with `400` and code `VALIDATION_SWEEP_EMPTY`.
- `sweep.repetitions` and `sweep.maxCases` must be integers `>= 1`.

- If `sweep` is present, the selected workload must contain exactly one workload case for v0.0.1.
  - Otherwise reject with `400` and code `VALIDATION_SWEEP_INVALID`.
- Axis values must be JSON-only. Reject values containing:
  - `undefined`
  - non-finite numbers (`NaN`, `Infinity`, `-Infinity`)
  - non-plain-JSON objects (for example `Date`, `Map`, `Set`, class instances)
  - circular references
  - `BigInt`
  - symbols

- `sweep.axes.serverArgs` validation (creation-time, lightweight):
  - Reject reserved/core-owned flags (model/host/port/api-key/webui and any other flags owned by core/plugin) in any axis argv fragment.
  - Reject denylisted flags/values that can write files or expand network exposure.
  - This validation must not require repeated remote `llama-server --help` probes.

- `sweep.axes.requestParams` validation (creation-time):
  - Reject reserved request param keys owned by the orchestrator (at minimum: `messages`, `model`, `stream`).
  - Each axis value must pass the same request-param node/depth/string-length budget validation used for `engine.requestParams`.

- Merged server args safety:
  - Let `baseCount = engine.serverArgs.length` after plugin normalization.
  - Let `sweepMaxAdditional = sum(longestFragmentLengthPerServerArgAxis)`.
  - If `baseCount + sweepMaxAdditional > 64`, reject with `400` and code `VALIDATION_SWEEP_INVALID`.

- If any of the above validations fail, reject with `400` and code `VALIDATION_SWEEP_INVALID`.

- Temporary rollout gate (post-PR review safety decision):
  - If sweep validation passes, reject with `400` and code `VALIDATION_SWEEP_NOT_SUPPORTED` until Task 3 + Task 4 are implemented.

- Post-gate progress accounting (required once Tasks 3/4 remove the temporary rejection):
  - When `sweep` is present, create the run with `totalCases = plannedCases` (not workload case count) so status + SSE progress are correct.

#### Post-Review Notes (2026-03-04)

- Review findings and final decisions for Tasks 1-2 are tracked in `review-findings.md`.

#### Manual Testing Steps

Run validation-focused tests (to be added in the implementation for this task):

```bash
bun test tests/app-runs.test.ts -t "sweep"
```

Manual server smoke (valid sweep is currently rejected by temporary gate, invalid sweeps still return validation errors):

1) Start the server.

2) Create a syntactically valid sweep run (expect `400 VALIDATION_SWEEP_NOT_SUPPORTED`):

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:4096/runs \
  -d '{
    "engineId": "llama-cpp",
    "target": { "type": "local" },
    "model": { "identifier": "/models/model.gguf" },
    "workloadId": "tuning.v0_0_1",
    "engine": { "serverArgs": [], "requestParams": {} },
    "validationMode": "permissive",
    "sweep": {
      "axes": {
        "serverArgs": {
          "ctxSize": [
            ["--ctx-size", "4096"],
            ["--ctx-size", "8192"]
          ],
          "gpuLayers": [
            ["--n-gpu-layers", "0"],
            ["--n-gpu-layers", "33"]
          ]
        },
        "requestParams": {
          "max_tokens": [256, 512]
        }
      },
      "maxCases": 32,
      "repetitions": 1
    }
  }'
```

3) Oversize on purpose (expect `400 VALIDATION_SWEEP_TOO_LARGE`):

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:4096/runs \
  -d '{
    "engineId": "llama-cpp",
    "target": { "type": "local" },
    "model": { "identifier": "/models/model.gguf" },
    "workloadId": "tuning.v0_0_1",
    "validationMode": "permissive",
    "sweep": {
      "axes": {
        "requestParams": {
          "max_tokens": [1,2,3,4,5,6,7,8,9,10]
        }
      },
      "maxCases": 2,
      "repetitions": 1
    }
  }'
```

4) Verify server-wide ceiling is enforced (expect `400 VALIDATION_SWEEP_TOO_LARGE`):

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:4096/runs \
  -d '{
    "engineId": "llama-cpp",
    "target": { "type": "local" },
    "model": { "identifier": "/models/model.gguf" },
    "workloadId": "tuning.v0_0_1",
    "validationMode": "permissive",
    "sweep": {
      "axes": { "requestParams": { "max_tokens": [1] } },
      "maxCases": 1000,
      "repetitions": 1
    }
  }'
```

5) Verify reserved keys/flags are rejected (expect `400 VALIDATION_SWEEP_INVALID`):

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:4096/runs \
  -d '{
    "engineId": "llama-cpp",
    "target": { "type": "local" },
    "model": { "identifier": "/models/model.gguf" },
    "workloadId": "tuning.v0_0_1",
    "validationMode": "permissive",
    "sweep": {
      "axes": {
        "serverArgs": { "bad": [["--port", "1234"]] },
        "requestParams": { "messages": [[{"role":"user","content":"x"}]] }
      },
      "maxCases": 32,
      "repetitions": 1
    }
  }'
```

### Task 3: Implement Deterministic Expansion And Stable Case Identities

#### Temporary Gate Removal Coupling (Required)

- Task 3 must be coordinated with Task 4 to remove the temporary
  `VALIDATION_SWEEP_NOT_SUPPORTED` gate introduced after PR #21 review.
- Do not leave the temporary gate in place once deterministic expansion and
  execution wiring are complete.

#### Deterministic Expansion

- Axis namespaces expand in this order:
  1) `sweep.axes.serverArgs` axis keys (sorted lexicographically)
  2) `sweep.axes.requestParams` axis keys (sorted lexicographically)
- Within each axis, preserve the input list ordering.
- Build the cartesian product across all axes.
- After generating each axis combination, apply `repetitions` by emitting the same combination `repetitions` times with a `repetitionIndex` in `[0, repetitions-1]`.

#### Case Identity (Hash-Based, Future-Proof)

Each expanded case must have a stable identity derived from the inference-affecting configuration.

- Build a canonical JSON object with these fields (minimum):
  - `engineId`
  - `modelIdentifier` (normalized identifier used for execution)
  - `workloadId`
  - `promptId`
  - `engineArgs` (final argv array used to launch the engine for this case)
  - `requestParams` (final request params object for this case)

- Canonicalization rules:
  - Only JSON values are allowed:
    - `null`, booleans, strings, finite numbers, arrays, plain objects
  - Reject any case config value containing:
    - `undefined`
    - non-finite numbers (`NaN`, `Infinity`, `-Infinity`)
    - `BigInt`
    - symbols
    - functions
    - circular references
    - non-plain objects (for example `Date`, `Map`, `Set`, class instances)
  - All object keys are sorted lexicographically at every object level.
  - Arrays preserve order.

- Canonical JSON algorithm (must be stable across runs and refactors):
  - Normalize the case-config object by recursively sorting keys and validating JSON-only values.
  - Produce canonical JSON with `JSON.stringify(normalizedValue)`.

- Compute:
  - `caseConfigId = "sweep_" + sha256Hex(canonicalJson(caseConfigWithoutRepetition))`
  - `caseId = caseConfigId + ".rep-" + (repetitionIndex + 1)`

#### Manual Testing Steps

Run deterministic expansion tests (to be added in the implementation for this task):

```bash
bun test tests/app-runs.test.ts -t "deterministic"
```

Run golden fixture tests that lock hash stability (to be added in the implementation for this task):

```bash
bun test tests/app-runs.test.ts -t "hash"
```

Optional local check after implementation:

```bash
bun test tests/app-runs.test.ts -t "caseId"
```

### Task 4: Implement Sweep Execution With Restart-Per-Case

When `sweep` is present, execute expanded cases sequentially and restart the engine between cases.

- As part of Task 4 completion, remove the temporary
  `VALIDATION_SWEEP_NOT_SUPPORTED` gate from `POST /runs`.

#### Workload Constraint (v0.0.1)

- The selected `workloadId` must contain exactly 1 workload case.
  - If `workload.cases.length !== 1`, reject `POST /runs` with `400` and code `VALIDATION_SWEEP_WORKLOAD_NOT_SUPPORTED`.
  - Rationale: Sweep MVP varies launch args and request params; it does not yet define multi-prompt sweep semantics.

#### Execution Loop

For each expanded case:

1) Build launch config for that case's `engineArgs`.
2) `start` engine.
3) `waitUntilReady`.
4) Execute exactly one workload case with that case's `requestParams`.
5) Collect metrics.
6) `stop` engine.

#### Per-Case Validation And Failure Handling

- Sweep execution must be resilient to partial failures:
  - If a single case is invalid (reserved flags, invalid request param types, etc.), record that case as `failed` and continue to the next case.
  - If a case cannot start the engine or fails readiness, record that case as `failed` and continue when possible.
  - If the runtime enters a state where continuing is unsafe/impossible (for example repeated SSH transport failure), fail the run and mark remaining cases as failed.

- Recommended behavior for validation:
  - Validate the sweep config itself at `POST /runs` time (axes shape, `maxCases`, JSON-serializable values).
  - Validate each expanded case config just-in-time before starting the engine for that case.
    - If validation fails, do not start the engine; record the case as failed with a stable validation error code/message.

#### Infrastructure Failure Threshold (v0.0.1)

- Define an explicit stop condition to avoid spending hours retrying a broken environment:
  - `MAX_CONSECUTIVE_ENGINE_LIFECYCLE_FAILURES = 3`

- Count an engine lifecycle failure when:
  - engine `start()` fails, or
  - engine `waitUntilReady()` fails, or
  - an SSH transport/probe required for engine lifecycle fails.

- Do not count pure per-case validation failures (bad args/params) toward the consecutive-infra-failure threshold.
- When the threshold is exceeded, fail the run and mark remaining cases as failed.

#### State, Events, And Cancellation

- Reuse existing run events (`run.case.started`, `run.case.completed`, `run.case.failed`, terminal run events). Do not introduce a new sweep-specific event taxonomy for v0.0.1.
- Event payload guidance:
  - Include `runId`, `caseId`, `index`, and progress counts.
  - Do not emit full per-case `engineArgs` / `requestParams` in SSE payloads for v0.0.1 (can be large and may contain sensitive values).
- Cancellation uses existing `POST /runs/:runId/cancel`:
  - Stop the currently-running engine.
  - Transition run to `cancelled`.
  - Persist a terminal `result.json` that includes completed/failed cases so far.
  - If cancellation happens between cases (engine already stopped), transition immediately without attempting a new engine start.

#### Storage Constraint To Call Out (Required For Correct Artifacts)

Because sweep cases vary `engineArgs` and `requestParams` per case, run storage must record these per case outcome (not only at the run level).

- Required implementation approach:
  - Pass per-case `engineArgs` into the case outcome recorder (do not rely on a single run-level `engineArgs`).
  - Do not implement this by mutating `run.engineArgs` between cases.

Ensure the persisted `cases[*].engineArgs` and `cases[*].requestParams` reflect the per-case values used.

#### Manual Testing Steps

Run the sweep execution tests (to be added in the implementation for this task):

```bash
bun test tests/app-runs.test.ts -t "sweep execution"
```

Cancellation boundary tests (to be added in the implementation for this task):

```bash
bun test tests/app-runs.test.ts -t "sweep cancel"
```

End-to-end smoke over SSH:

1) Start the server.
2) Create a sweep run (use the curl example from Task 2).
3) Poll until terminal status:

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/runs/<runId>
```

4) Fetch the result:

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/runs/<runId>/result
```

5) Confirm restart-per-case behavior from server logs (look for repeated start/ready/stop diagnostics per case).

#### Post-Review Follow-up (2026-03-04)

- SSH sweep shutdown hardening landed after manual remote validation found
  orphaned remote `llama-server` processes could accumulate and consume GPU
  memory across runs.
- Follow-up implementation now uses:
  - stronger remote cleanup process matching,
  - explicit null/indeterminate cleanup-exit handling,
  - TERM -> liveness check -> conditional KILL cleanup flow,
  - idempotent stop guards for concurrent stop calls,
  - dependency-configurable remote cleanup timeout/grace knobs.
- Full decision log and file mapping is tracked in `review-findings.md` under
  "SSH Sweep Shutdown Follow-up Findings (2026-03-04)".

### Task 5: Persist Artifacts And Rank Results

Persist a single `runs/{runId}/result.json` containing all sweep cases plus a deterministic ranking.

#### Artifact Requirements

- Persist per-case outcomes as the standard `cases[]` entries.
- Add a sweep-specific block to the persisted result (recommended shape):

```json
{
  "sweep": {
    "axes": { "serverArgs": {}, "requestParams": {} },
    "repetitions": 1,
    "maxCases": 32,
    "plannedCases": 8,
    "ranking": [
      { "rank": 1, "caseId": "...", "status": "completed", "tokensPerSecond": 123.4, "latencyMs": 1000 },
      { "rank": 2, "caseId": "...", "status": "failed" }
    ]
  }
}
```

#### Ranking Rules (Deterministic)

- Repetitions are ranked independently (no aggregation/averaging across `.rep-*` cases in v0.0.1).

- Completed cases first:
  - sort by `tokensPerSecond` descending
  - tie-breaker: `latencyMs` ascending
  - final tie-breaker: `caseId` ascending
- Failed cases after completed cases:
  - sort by `caseId` ascending

#### Manual Testing Steps

Run ranking tests (to be added in the implementation for this task):

```bash
bun test tests/app-runs.test.ts -t "ranking"
```

Manual artifact inspection after a sweep completes:

```bash
cat runs/<runId>/result.json
```

## Exit criteria

- A sweep run can execute end-to-end over SSH, producing a `runs/{runId}/result.json` with multiple cases and a deterministic ranking.

## Future follow-ups (tracked)

- Canonicalization allocation optimization (from Tasks 3-4 review finding L5):
  evaluate a future spec that replaces full canonical-JSON string materialization
  with streaming/incremental hashing for `caseConfigId` generation when payloads
  approach upper bounds.

## Dependencies

- `agent-os/specs/2026-02-23-1715-server-plugin-llama-cpp-foundation/`
- `agent-os/specs/2026-02-23-1720-ssh-remote-execution-profiles/`
- `agent-os/specs/2026-03-03-1200-tuning-workload-mvp/`
