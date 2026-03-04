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

#### Validation Rules

- If `sweep` is present, it must expand to at least 1 case.
- All axis lists must be non-empty.
- `sweep.maxCases` must be enforced against the planned total cases.
  - `plannedCases = (product of axis lengths across both namespaces) * repetitions`
- If `plannedCases > maxCases`, reject with `400` and code `VALIDATION_SWEEP_TOO_LARGE`.
- If `sweep` is present but axes are empty (no `serverArgs` and no `requestParams` axes), reject with `400` and code `VALIDATION_SWEEP_EMPTY`.
- If any axis contains a non-JSON-serializable value (for example `NaN`, circular objects), reject with `400` and code `VALIDATION_SWEEP_INVALID`.

#### Manual Testing Steps

Run validation-focused tests (to be added in the implementation for this task):

```bash
bun test tests/app-runs.test.ts -t "sweep"
```

Manual server smoke (tiny sweep is accepted, oversized sweep is rejected):

1) Start the server.

2) Create a sweep run:

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:4096/runs \
  -d '{
    "engineId": "llama-cpp",
    "target": { "type": "ssh", "profileId": "lab" },
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
    "target": { "type": "ssh", "profileId": "lab" },
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

### Task 3: Implement Deterministic Expansion And Stable Case Identities

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
  - All object keys are sorted lexicographically at every object level.
  - Arrays preserve order.
  - Values must be JSON-serializable.

- Compute:
  - `caseConfigId = "sweep_" + sha256Hex(canonicalJson(caseConfigWithoutRepetition))`
  - `caseId = caseConfigId + ".rep-" + (repetitionIndex + 1)`

#### Manual Testing Steps

Run deterministic expansion tests (to be added in the implementation for this task):

```bash
bun test tests/app-runs.test.ts -t "deterministic"
```

Optional local check after implementation:

```bash
bun test tests/app-runs.test.ts -t "caseId"
```

### Task 4: Implement Sweep Execution With Restart-Per-Case

When `sweep` is present, execute expanded cases sequentially and restart the engine between cases.

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

#### State, Events, And Cancellation

- Reuse existing run events (`run.case.started`, `run.case.completed`, `run.case.failed`, terminal run events). Do not introduce a new sweep-specific event taxonomy for v0.0.1.
- Cancellation uses existing `POST /runs/:runId/cancel`:
  - Stop the currently-running engine.
  - Transition run to `cancelled`.
  - Persist a terminal `result.json` that includes completed/failed cases so far.

#### Storage Constraint To Call Out (Required For Correct Artifacts)

Because sweep cases vary `engineArgs` and `requestParams` per case, run storage must record these per case outcome (not only at the run level). Ensure the persisted `cases[*].engineArgs` and `cases[*].requestParams` reflect the per-case values used.

#### Manual Testing Steps

Run the sweep execution tests (to be added in the implementation for this task):

```bash
bun test tests/app-runs.test.ts -t "sweep execution"
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

## Dependencies

- `agent-os/specs/2026-02-23-1715-server-plugin-llama-cpp-foundation/`
- `agent-os/specs/2026-02-23-1720-ssh-remote-execution-profiles/`
- `agent-os/specs/2026-03-03-1200-tuning-workload-mvp/`
