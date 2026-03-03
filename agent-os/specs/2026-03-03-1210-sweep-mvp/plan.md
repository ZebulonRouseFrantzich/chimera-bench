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

1. Save spec documentation (this folder).
   - Ensure this spec folder contains:
     - `plan.md`
     - `shape.md`
     - `references.md`
     - `standards.md`
     - `visuals/README.md`

2. Extend run creation schema with a sweep config (explicit lists).
   - Add `sweep.axes.serverArgs` and `sweep.axes.requestParams`.
   - Enforce `maxCases` to prevent combinatorial explosions.

3. Implement deterministic expansion.
   - Sort axis keys.
   - Preserve input list ordering within each axis.
   - Apply cartesian product across axes and then apply `repetitions`.

4. Implement sweep execution with restart-per-case.
   - For each expanded case:
     - start engine
     - wait ready
     - execute exactly one workload case
     - collect metrics
     - stop engine

5. Persist artifacts and rank results.
   - Persist all cases to `runs/{runId}/result.json`.
   - Rank best-to-worst using a simple score:
     - completed cases ranked by `tokensPerSecond` desc (tie-breaker: `latencyMs` asc)
     - failed cases ranked after completed cases

## Manual testing steps

1. Start the server.
2. Start a sweep run (example shows two 2-value axes):

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

## Exit criteria

- A sweep run can execute end-to-end over SSH, producing a `runs/{runId}/result.json` with multiple cases and a deterministic ranking.

## Dependencies

- `agent-os/specs/2026-02-23-1715-server-plugin-llama-cpp-foundation/`
- `agent-os/specs/2026-02-23-1720-ssh-remote-execution-profiles/`
- `agent-os/specs/2026-03-03-1200-tuning-workload-mvp/`
