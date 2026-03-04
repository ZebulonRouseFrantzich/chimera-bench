# Workload Packs and Exports

## Objective

Define realistic benchmark workloads and produce portable run outputs for analysis.

## Context carried from shaping

- The initial workload strategy is a few high-quality prompts, not a full benchmark methodology clone.
- Prompt/context inputs should resemble real technical usage patterns.
- Export artifacts remain file-based in early phases.

## Deliverables

- Workload pack format (prompt IDs, prompt text, optional context docs, expected output constraints).
- Built-in starter workload with high-quality technical prompts.
- Context injection support from local files.
- Export pipeline for `cases.csv` and `summary.md` derived from `result.json`.
- Stable mapping between run schema fields and export columns.
- Workload APIs (route group: `/workloads`) for listing and selecting workloads.
- Export read APIs (route group: `/exports`) for retrieving CSV and markdown artifacts.
- Workload file safety: allowlist workload pack roots via `CHIMERA_WORKLOAD_ROOTS`.

## Standards applied

- `agent-os/standards/runs/result-schema.md`
- `agent-os/standards/server/api-conventions.md`

## Reference implementations

- See `references.md`.

## Non-goals

- Full sweep orchestration.
- Remote execution.
- UI dashboards.

## Implementation tasks

1. Define workload pack format and validation rules.
   - Define a `WorkloadPack` schema (zod) with stable identifiers:
     - `workloadId` (string, required; pattern `[a-z0-9_-]+`)
     - `displayName` (string, required)
     - `version` (string, required)
     - `prompts` (non-empty array)
   - Prompt schema (initial):
     - `promptId` (string, required; pattern `[a-z0-9_-]+`)
     - `messages` (array of chat messages; `role` + `content`)
     - `contextFiles` (string[], optional; paths relative to the pack directory)
     - `notes` (string, optional)
   - Validation rules:
     - Reject absolute paths in `contextFiles`.
     - Reject `..` segments and any path that escapes the pack directory.
     - Enforce a maximum prompt count per pack (configurable) to avoid accidental huge runs.
   - Manual testing steps:
     - Load a known-good pack in unit tests.
     - Attempt to load an invalid pack (bad IDs, `..` traversal) and verify a stable `VALIDATION_*` error.

2. Add a built-in starter workload pack and a loader.
   - Ship a built-in pack (3-10 high-quality technical prompts) with a stable `workloadId`.
   - Implement a loader that can:
     - list available packs (built-in + file-based)
     - load a pack by `workloadId`
   - Add file-based pack loading under an allowlisted root:
     - Env var: `CHIMERA_WORKLOAD_ROOTS` (colon-separated directories).
     - Only load packs from directories under `CHIMERA_WORKLOAD_ROOTS`.
   - Add workload APIs (route group: `/workloads`):
     - `GET /workloads` -> list packs (`workloadId`, `displayName`, `version`, prompt count)
     - `GET /workloads/:workloadId` -> pack metadata (do not return full prompt contents by default)
   - Manual testing steps:
     - `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/workloads`
     - `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/workloads/<workloadId>`
     - Set `CHIMERA_WORKLOAD_ROOTS` and confirm a pack on disk appears in `GET /workloads`.

3. Implement context document ingestion and token-budget handling.
   - Resolve `contextFiles` relative to the pack directory; read as UTF-8 text.
   - Enforce safety limits:
     - Max file size per context doc (configurable).
     - Max combined context size per prompt (configurable).
   - Token-budget handling:
     - If a tokenizer is available, use it.
     - Otherwise use a documented approximation (e.g., `ceil(chars / 4)`) until a tokenizer is introduced.
     - When over budget: truncate context (preferred) or fail the case with an explicit error (document behavior).
   - Manual testing steps:
     - Add a pack prompt that references a small context file; verify the run succeeds.
     - Reference a missing file; verify the case fails with a stable `VALIDATION_*` or `RUN_*` error.
     - Reference a large file; verify truncation or failure behavior matches the documented policy.

4. Implement CSV and markdown exporters derived from `result.json`.
   - Export behavior:
     - Generate `runs/{runId}/cases.csv` and `runs/{runId}/summary.md` from `runs/{runId}/result.json`.
     - Write atomically (temp + rename) and keep output stable across runs.
     - Add an idempotent regeneration path (safe to rerun without changing semantics).
   - Mapping:
     - CSV rows correspond 1:1 with result-schema cases.
     - Preserve required fields and include `metricsExtra` as a JSON column if present.
   - Surfaces:
     - Generate exports automatically on run completion.
     - Add export read APIs (route group: `/exports`):
       - `GET /exports/runs/:runId/cases.csv`
       - `GET /exports/runs/:runId/summary.md`
   - Manual testing steps:
     - Run a benchmark to completion.
     - Verify files exist: `ls runs/RUN_ID/cases.csv runs/RUN_ID/summary.md`
     - Fetch via API:
       - `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/exports/runs/RUN_ID/cases.csv`
       - `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/exports/runs/RUN_ID/summary.md`

5. Add fixture-based tests for exporter stability.
    - Add a small `result.json` fixture and golden outputs for `cases.csv` and `summary.md`.
    - Fail tests on any output drift unless explicitly updated.
    - Manual testing steps:
      - Run tests: `bun test`

## Post v0.0.1 follow-ups (engine hardening)

These items are intentionally deferred until after v0.0.1.
They are not required to meet this spec's exit criteria, but they reduce operator friction when running workload packs against SSH targets.

6. Validate explicit GPU selector values for mixed-GPU SSH targets.
   - Background:
     - Mixed-GPU SSH hosts (dGPU + iGPU) can be unstable when `llama-server` auto-selects devices.
     - v0.0.1 adds a guard that requires an explicit selector flag, but does not validate the selector value.
   - Extend validation to reject invalid selector values before run creation:
     - `--device <dev1,dev2,...>`:
       - Accept `none`.
       - Accept comma-separated device identifiers (single argv token).
       - When remote GPU hints are available, require each device identifier to match a discovered identifier (e.g. `ROCm0`, `ROCm1`, `CUDA0`).
     - `--main-gpu <index>`:
       - Require an integer value.
       - When remote GPU hints are available, require the index to be one of the discovered `--main-gpu` values.
     - `--split-mode`:
       - Only treat as satisfying the mixed-GPU guard when the value is `none`.
   - Failure mode when discovery is unavailable:
     - Keep validation fail-open (do not block run creation solely because discovery failed).
     - Emit an operator-visible console log noting that GPU value validation was skipped.
   - Manual testing steps:
     - Mixed-GPU SSH target without selector -> validation error with detected options.
     - Mixed-GPU SSH target with invalid selector value (example: `--device ROCm`) -> validation error (do not reach engine startup).
     - Mixed-GPU SSH target with `--device ROCm0` -> accepted.
     - Mixed-GPU SSH target with `--device ROCm0,ROCm1` and `--device none` -> accepted.

## Exit criteria

- A completed run generates consistent JSON, CSV, and markdown artifacts from the same data source.

## Dependencies

- Requires `server-plugin-llama-cpp-foundation`.
