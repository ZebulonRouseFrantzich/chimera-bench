# Workload Packs and Exports

## Objective

Define realistic benchmark workloads and produce portable run outputs for analysis.

## Context carried from shaping

- The initial workload strategy is a few high-quality prompts, not a full benchmark methodology clone.
- Prompt/context inputs should resemble real technical usage patterns.
- Export artifacts remain file-based in early phases.
- v0.1.0 implements this spec alongside `agent-os/specs/2026-02-23-1717-sweep-engine-run-orchestration/`.
  Workload pack prompt IDs must be stable and discoverable so sweeps can select prompts deterministically.

## Deliverables

- Workload pack format + validation (`workload.json`, prompt/message structure, optional context files).
- Standardized built-in workload IDs in the format `type.vN` (example: `starter.v1`, `tuning.v1`).
  - When a built-in workload changes, it must be published under a new `type.v{N+1}` ID.
- Built-in high-quality technical starter workload pack (new ID, not a silent mutation of existing built-ins).
- Context injection support from local files with strict path confinement and size budgets.
- Export pipeline for `cases.csv` and `summary.md` derived from `runs/{runId}/result.json`.
- Stable mapping between run schema fields and export columns/sections.
- Workload APIs (route group: `/workloads`) for listing and selecting workloads.
- Workloads reload API to rescan filesystem packs without restart.
- Export read APIs (route group: `/exports`) for retrieving CSV and markdown artifacts.
- NDJSON case export for large sweeps.
- Single-file export bundle for sharing (result + exports).
- Run artifacts index API so clients can discover available artifacts.
- Workload file safety: allowlist workload pack roots via `CHIMERA_WORKLOAD_ROOTS`.
- Persist workload digests (pack + referenced context docs) into `result.json` and exports for reproducibility.
- CLI workload pack validator for pack authors.
- OpenAPI/SDK artifacts updated and drift-free when routes/schemas change.

## Standards applied

- `agent-os/standards/server/api-conventions.md`
- `agent-os/standards/runs/result-schema.md`
- `agent-os/standards/runs/artifact-store.md`
- `agent-os/standards/runs/built-in-workload-hardening.md`
- `agent-os/standards/global/sanitization-and-safe-errors.md`
- `agent-os/standards/server/openapi-and-sdk-artifacts.md`
- `agent-os/standards/server/request-param-budgets.md`
- `agent-os/standards/cli/arg-parsing.md`
- `agent-os/standards/cli/exit-codes.md`

## Reference implementations

- See `references.md`.

## Non-goals

- Full benchmark methodology clone.
- Remote workload pack fetching.
- UI dashboards.

## Compatibility notes (v0.1.0 + sweep orchestration)

- Workload packs must expose stable `promptId`s and preserve prompt ordering.
  `agent-os/specs/2026-02-23-1717-sweep-engine-run-orchestration/` will reference prompt IDs for
  sweep prompt selection and deterministic case identity.
- Exports must remain usable for both single runs and sweeps:
  - CSV must include per-case `engine_args_json` + `request_params_json` so sweep configs can be reconstructed.
  - Markdown summary must include sweep ranking and aggregates when present in `result.json`.

## Implementation tasks

### Task 1: Save Spec Documentation

- Update this spec folder to reflect the decisions in this conversation:
  - Standardized built-in workload IDs: `type.vN`.
  - `CHIMERA_WORKLOAD_ROOTS` parsing policy (see Task 4).
  - Consistent `#### Manual Testing` section for every task.
  - Explicit OpenAPI/SDK artifact workflow.
  - Validate and document that per-run timeouts are already implemented (see "Already implemented" section).
- Keep `standards.md` and `plan.md` “Standards applied” lists aligned.

#### Manual Testing

1) Verify spec files exist:

```bash
ls -la agent-os/specs/2026-02-23-1716-workload-packs-and-exports/
```

2) Verify every task has a `Manual Testing` section:

```bash
rg -n "^### Task |^#### Manual Testing" agent-os/specs/2026-02-23-1716-workload-packs-and-exports/plan.md
```


### Task 2: Standardize Built-in Workload IDs (`type.vN`)

- Goal: all built-in workload IDs follow `type.vN` so version bumps are explicit and stable.
- Update built-in workload IDs:
  - Keep `starter.v1` unchanged.
  - Rename the tuning workload from `tuning.v0_0_1` to `tuning.v1`.
    - Update its `caseId` and `promptId` to match the new workload ID prefix.
    - Re-baseline any regression hash tests that intentionally lock the prompt contract.
- Default workload selection:
  - Add a new high-quality starter pack as `starter.v2` (do not mutate `starter.v1`).
  - Set the server default workload ID to `starter.v2` for v0.1.0.
  - Keep `starter.v1` and `tuning.v1` selectable explicitly.
- Documentation:
  - Update any curl examples in specs that reference `tuning.v0_0_1` to `tuning.v1`.

#### Manual Testing

1) Run targeted tests for built-in workload IDs and regression hashes:

```bash
bun test tests/starter-workload.test.ts
```

2) Start the server and list workloads (once `/workloads` exists from Task 4):

```bash
export CHIMERA_SERVER_PASSWORD='a-strong-dev-password'
bun run serve
```

3) Confirm the response includes `starter.v1`, `starter.v2`, and `tuning.v1`.


### Task 3: Define Workload Pack Format and Validation Rules

- On-disk format:
  - A workload pack is a directory containing `workload.json` at the pack root.
  - Context docs are files within the pack directory and are referenced by relative path.
- Schema (zod) for `workload.json`:
  - `schemaVersion`: number (required; start at `1`).
  - `workloadId`: string (required; must match `^[a-z][a-z0-9-]*\.v[1-9][0-9]*$`; max length 128).
  - `displayName`: string (required).
  - `version`: string (required; informational; does not replace workloadId versioning).
  - `prompts`: non-empty array.
  - Prompt fields:
    - `promptId`: string (required; max length 128; recommended prefix `${workloadId}.`).
    - `caseId`: string (required; max length 128; recommended prefix `${workloadId}.`).
    - `messages`: non-empty array of `{ role, content }`.
    - `contextFiles`: string[] (optional; paths relative to the pack directory).
    - `notes`: string (optional).
- Validation rules (security + determinism):
  - Reject absolute paths in `contextFiles`.
  - Reject `..` segments and any path that escapes the pack directory.
  - Enforce symlink-safe containment:
    - resolve + realpath the pack directory
    - resolve + realpath the referenced file
    - reject if the file’s real path is outside the pack directory
  - Enforce conservative budgets (configurable constants):
    - max prompts per pack
    - max messages per prompt
    - max message content bytes
    - max context files per prompt
  - Errors:
    - Use stable `VALIDATION_*` codes.
    - Client messages must not include absolute filesystem paths; log detailed `logReason` instead.

#### Manual Testing

1) Create a minimal workload pack on disk:

```bash
mkdir -p /tmp/chimera-workloads/minimal-pack
cat > /tmp/chimera-workloads/minimal-pack/workload.json <<'EOF'
{
  "schemaVersion": 1,
  "workloadId": "demo.v1",
  "displayName": "Demo workload",
  "version": "0.1.0",
  "prompts": [
    {
      "promptId": "demo.v1.prompt-1",
      "caseId": "demo.v1.case-1",
      "messages": [
        { "role": "user", "content": "Say hello in one sentence." }
      ]
    }
  ]
}
EOF
```

2) Start the server with `CHIMERA_WORKLOAD_ROOTS` pointing at `/tmp/chimera-workloads` (Task 4).

3) Confirm `demo.v1` appears in `GET /workloads`.

4) Path traversal check:
  - Set `contextFiles` to `../escape.txt`.
  - Confirm the pack is rejected with a stable `VALIDATION_*` error and no reads occur outside the pack.


### Task 4: Implement Workload Registry + Loader + `/workloads` APIs

- Loader sources:
  - Built-in packs (compiled into the binary).
  - File-based packs under allowlisted roots.
- `CHIMERA_WORKLOAD_ROOTS` parsing:
  - Prefer one delimiter across platforms if feasible, but for correctness use OS delimiter via `node:path` `delimiter`.
    - Linux/macOS: `:`
    - Windows: `;`
  - Rationale: aligns with existing `CHIMERA_MODEL_ROOTS` parsing and avoids Windows drive-letter ambiguity.
- Discovery strategy (perf + safety):
  - For each root, scan one directory level for subdirectories containing `workload.json`.
  - Do not recurse deeply.
  - Validate every candidate pack; skip invalid packs with a safe log.
  - Duplicate `workloadId` policy:
    - built-in wins over file-based
    - file-vs-file: select deterministically (stable sort by path)
  - Keep an in-memory cache of discovered metadata; refresh on process restart.
- APIs:
  - `GET /workloads` (enveloped JSON): list packs with metadata only.
    - Fields: `workloadId`, `displayName`, `version`, `promptCount`, `source` (`built-in` | `filesystem`).
  - `GET /workloads/:workloadId` (enveloped JSON):
    - default: metadata + `promptIds` list (no messages/prompt bodies)
    - `?includePrompts=1`: include prompt message bodies (bounded by a response-size limit).
  - `POST /workloads/reload` (enveloped JSON): rescan `CHIMERA_WORKLOAD_ROOTS` and refresh the in-memory index.
    - Response includes counts (example: discovered packs, skipped invalid packs, duplicate-id skips).
  - Do not expose absolute filesystem paths in API responses.
- OpenAPI/SDK:
  - Add route schemas and OpenAPI path registrations for `/workloads`.
  - Regenerate artifacts per `server/openapi-and-sdk-artifacts`.

#### Manual Testing

1) Start server with a workload root:

```bash
export CHIMERA_SERVER_PASSWORD='a-strong-dev-password'
export CHIMERA_WORKLOAD_ROOTS="/tmp/chimera-workloads"
CHIMERA_BENCH_DEV=1 bun run serve
```

2) List workloads:

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/workloads
```

3) Fetch metadata (should include `promptIds` but not message bodies):

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/workloads/demo.v1
```

4) Fetch prompts explicitly:

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD "http://127.0.0.1:4096/workloads/demo.v1?includePrompts=1"
```

5) Duplicate ID check:
  - Create a second pack directory under the root with the same `workloadId`.
  - Confirm only one instance appears and selection is deterministic.

6) Reload without restart:
  - Add a new pack directory under `/tmp/chimera-workloads`.
  - Call reload:

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD -X POST http://127.0.0.1:4096/workloads/reload
```

  - Confirm the new pack appears in `GET /workloads`.


### Task 5: Implement Context Document Ingestion + Prompt Assembly

- Resolve `contextFiles` relative to the pack directory; read as UTF-8 text.
- Enforce safety limits (configurable constants):
  - max bytes per context file
  - max combined context bytes per prompt
  - max number of context files per prompt
- Truncation policy:
  - Prefer deterministic truncation with a stable marker (example: `\n...[truncated]...\n`).
  - Document whether truncation occurs per-file or after concatenation.
- Injection format:
  - Prepend a system message containing context docs with explicit markers:
    - `BEGIN_CONTEXT <relative_path>`
    - `END_CONTEXT <relative_path>`
  - Preserve pack message ordering after the injected system message.
- Token-fit preflight alignment:
  - Ensure the string used for preflight token estimation includes the injected context.
  - Keep behavior deterministic (same pack -> same injected message text).

#### Manual Testing

1) Add a small context file:

```bash
mkdir -p /tmp/chimera-workloads/minimal-pack/docs
printf "MAGIC_PHRASE=kiwi-42\n" > /tmp/chimera-workloads/minimal-pack/docs/context.txt
```

2) Update `workload.json` to reference `docs/context.txt` and instruct the model to output `MAGIC_PHRASE`.

3) Run a benchmark (requires a runnable engine/model) and confirm the output includes `kiwi-42`.

4) Missing file check:
  - Reference a non-existent context file.
  - Confirm the case fails with a stable `VALIDATION_*` or `RUN_*` error (and logs include the detailed reason).

5) Oversize file check:
  - Reference a large file.
  - Confirm truncation (or explicit failure) matches the documented policy.


### Task 6: Persist Workload Digest + Provenance into `result.json`

- Goal: runs remain comparable even if a filesystem pack changes later.
- Compute a workload digest for every run:
  - Base input: canonicalized `workload.json`.
  - Include referenced context docs:
    - For every `contextFiles[]` actually used by executed prompts, compute `sha256(contents)`.
    - Record only relative paths + hashes + byte sizes (never absolute paths).
  - Keep ordering deterministic (sort by relative path).
- Persist provenance into `runs/{runId}/result.json`:
  - Add a top-level `workloadPack` object (additive; keep existing `workloadId` top-level field):
    - `schemaVersion` (pack schema version)
    - `version` (from `workload.json`)
    - `source` (`built-in` | `filesystem`)
    - `digestSha256`
    - `contextDigests` (array of `{ path, sha256, bytes }`)
- Surface provenance in exports:
  - `summary.md` should include `workloadId` + `digestSha256`.
  - CSV does not need a digest column (digest is run-level), but the bundle should include `result.json`.

#### Manual Testing

1) Run a benchmark to completion.

2) Confirm `result.json` includes `workloadPack.digestSha256` and the pack `source`:

```bash
rg -n "\"workloadPack\"" runs/RUN_ID/result.json
```

3) Filesystem pack change detection:
  - Edit `workload.json` or a referenced context file.
  - Reload workloads (`POST /workloads/reload`).
  - Re-run and confirm `digestSha256` changes.


### Task 7: Implement Exports (`cases.csv`, `summary.md`, `cases.ndjson`, `bundle.tgz`) + `/exports` APIs

- Export behavior:
  - Generate exports from `runs/{runId}/result.json`:
    - `runs/{runId}/cases.csv`
    - `runs/{runId}/summary.md`
    - `runs/{runId}/cases.ndjson`
    - `runs/{runId}/bundle.tgz`
  - Write atomically (temp + rename) and keep outputs deterministic.
  - Provide idempotent regeneration: safe to re-run without semantic drift.
  - Generate exports automatically on run completion.
  - If an export is requested before it exists, generate on-demand from `result.json`.
- CSV mapping:
  - Rows correspond 1:1 with result-schema cases.
  - Headers use `snake_case`.
  - Include `metricsExtra` as `metrics_extra_json` when present.
  - Include `engine_args_json` and `request_params_json` so sweep case configs can be reconstructed.
- NDJSON mapping:
  - One JSON object per line.
  - Each line includes the full case record (using the same key names as `result.json` case objects).
- Bundle behavior:
  - `bundle.tgz` includes at minimum:
    - `result.json`
    - `cases.csv`
    - `cases.ndjson`
    - `summary.md`
  - Bundle generation is deterministic:
    - stable file order
    - fixed timestamps/metadata so the archive is byte-stable for identical inputs
- API surfaces (raw, not enveloped):
  - `GET /exports/runs/:runId/cases.csv` -> `text/csv`
  - `GET /exports/runs/:runId/summary.md` -> `text/markdown`
  - `GET /exports/runs/:runId/cases.ndjson` -> `application/x-ndjson`
  - `GET /exports/runs/:runId/bundle.tgz` -> `application/gzip`
  - Include `Content-Disposition` filenames.
- OpenAPI/SDK:
  - Register `/exports` paths with correct content types.
  - Regenerate OpenAPI/SDK artifacts.

#### Manual Testing

1) Run a benchmark to completion (any workload).

2) Confirm files exist:

```bash
ls -la runs/RUN_ID/cases.csv runs/RUN_ID/summary.md runs/RUN_ID/cases.ndjson runs/RUN_ID/bundle.tgz
```

3) Fetch via API and confirm content types:

```bash
curl -i -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/exports/runs/RUN_ID/cases.csv
curl -i -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/exports/runs/RUN_ID/summary.md
curl -i -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/exports/runs/RUN_ID/cases.ndjson
curl -i -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/exports/runs/RUN_ID/bundle.tgz -o /tmp/chimera-bundle.tgz
```

4) Inspect the bundle contents:

```bash
tar -tzf /tmp/chimera-bundle.tgz
```

5) Delete one export file and re-fetch; confirm it is regenerated deterministically.


### Task 8: Add Run Artifacts Index API (`GET /runs/:runId/artifacts`)

- Add an enveloped JSON endpoint that lists which run artifacts are available.
- Response shape (example):
  - `artifacts[]`: `{ name, contentType, bytes, url, exists }`
  - Include at least: `result.json`, `cases.csv`, `cases.ndjson`, `summary.md`, `bundle.tgz`.
- Do not expose absolute filesystem paths.
- OpenAPI/SDK:
  - Register the endpoint in OpenAPI and regenerate artifacts.

#### Manual Testing

1) Complete a run.

2) Fetch the index:

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/runs/RUN_ID/artifacts
```

3) Confirm URLs match the corresponding `/runs` and `/exports` routes and `exists=true` for generated artifacts.


### Task 9: Add CLI Workload Pack Validator

- Add a CLI command for pack authors:
  - `chimera-bench workloads validate <path>`
- Behavior:
  - Validates `workload.json` schema + budgets.
  - Validates context file path confinement (no `..`, no absolute, no symlink escapes).
  - Optionally computes/prints `digestSha256` so authors can lock revisions.
- Exit codes (per `cli/exit-codes`):
  - `0`: valid
  - `1`: invalid pack (schema/validation failure)
  - `2`: usage error (bad args, unknown options)

#### Manual Testing

1) Validate a known-good pack:

```bash
bun run ./bin/chimera-bench workloads validate /tmp/chimera-workloads/minimal-pack
echo $?
```

2) Break the pack (invalid workloadId, missing workload.json, traversal contextFiles) and confirm exit code `1`.

3) `--help` prints help and exits `0`; unknown options exit `2`.


### Task 10: Add Fixture-Based Tests + OpenAPI/SDK Drift Checks

- Add fixtures:
  - `result.json` fixture (small but representative; includes errors + metricsExtra when possible).
  - golden `cases.csv`, `cases.ndjson`, `summary.md` outputs.
- Fail tests on output drift unless explicitly updated.
- Add tests for:
  - workload pack validation and path confinement
  - `/workloads` responses (includePrompts gating, size ceiling, reload)
  - workload digest persistence (`workloadPack.digestSha256`)
  - `/exports` responses (raw content types, bundle contents)
  - `/runs/:runId/artifacts` index
  - CLI validator behavior and exit codes
- OpenAPI/SDK:
  - Ensure `bun run openapi:check` passes after regenerating artifacts.

#### Manual Testing

1) Run lint + tests:

```bash
bun run lint
bun test
```

2) Regenerate artifacts and verify drift-free state:

```bash
bun run openapi:generate
bun run sdk:generate
bun run openapi:check
```


## Follow-ups (engine hardening)

### Task 11: Validate Explicit GPU Selector Values for Mixed-GPU SSH Targets

- Extend mixed-GPU validation to reject invalid selector values when discovery hints are available:
  - `--device <dev1,dev2,...>`:
    - accept `none`
    - accept comma-separated identifiers in a single argv token
    - when hints are available, require membership in discovered identifiers
  - `--main-gpu <index>`:
    - require integer
    - when hints are available, require membership in discovered indices
  - `--split-mode`:
    - only treat as satisfying the mixed-GPU guard when value is `none`
- Failure mode when discovery is unavailable:
  - fail open (do not block run creation solely because discovery failed)
  - emit an operator-visible log noting validation was skipped

#### Manual Testing

1) Mixed-GPU SSH target without selector -> expect `SERVER_ARG_GPU_SELECTION_REQUIRED`.

2) Mixed-GPU SSH target with invalid selector -> expect validation error without starting the engine.

3) Mixed-GPU SSH target with valid selector -> accepted.


## Follow-ups (workload scenarios + prompt calibration)

### Task 12: Add Scenario-Style Prompt Variants to Workload Packs

- Add optional scenario variants (example: `small`, `medium`, `large`) with stable IDs.
- Each scenario selects a fixed `messages` bundle with stable identifiers.
- Ship tuning workloads with multiple scenario variants designed to fit common context windows.

#### Manual Testing

1) Create a pack with scenario variants.

2) Confirm `/workloads/:workloadId` exposes scenario metadata and that prompt selection (once implemented by the sweep spec) can target scenarios deterministically.


### Task 13: Add Prompt Calibration Policy Support for Sweeps

- Goal: keep a single fixed prompt per sweep run while avoiding repeated prompt-fit failures.
- Provide a default policy that chooses the largest scenario that fits:
  - the minimum `--ctx-size` across planned sweep cases (or a configured baseline)
  - plus headroom for requested output tokens
- Add prune mode:
  - choose a baseline context window and prune smaller-ctx cases instead of shrinking the prompt
- Add an explicit override so operators can pin a specific scenario and skip calibration.

#### Manual Testing

1) Run a sweep with `--ctx-size` as an axis and scenario variants available.

2) Confirm the selected scenario is stable and reflected in run artifacts/exports.


### Task 14: Reduce Sweep Restart Churn for Guaranteed Prompt-Overflow Cases

- Add deterministic preflight bucketing keyed by effective prompt/scenario + `--ctx-size`.
- When a bucket fails prompt-fit preflight, mark all matching cases as `VALIDATION_PROMPT_TOO_LARGE` without launching engine sessions.
- Preserve stable case ordering and artifact determinism.

#### Manual Testing

1) Run a sweep where every case is known oversize and confirm no repeated engine startup loops.

2) Run a mixed sweep and confirm only fit-capable buckets launch engine sessions.


## Already implemented (validated)

### Per-run timeout overrides

This repo already supports per-run timeout overrides (`timeouts.caseMs`, `timeouts.runMs`):

- Request schema validation (bounds + `caseMs <= runMs`) in `src/server/api/schemas.ts`.
- Orchestration enforcement and case abort semantics in `src/server/runs/run-orchestrator/`.
- Persistence into `runs/{runId}/result.json` under `timeouts` in `src/server/runs/in-memory-run-store/results.ts`.
- Test coverage:
  - `tests/app-runs/timeouts-and-startup-failures.ts`
  - `tests/app-runs/request-validation-core.ts`
  - `tests/app-runs/results-persistence.ts`

#### Manual Testing

1) Run the timeout-focused tests:

```bash
bun test tests/app-runs/timeouts-and-startup-failures.ts
```

2) Create a run with small timeouts and confirm the result shows `RUN_TIMEOUT_EXCEEDED` and includes `timeouts` in `result.json`.


## Exit criteria

- A completed run generates consistent JSON, CSV, and markdown artifacts derived from the same data source.
- Workload packs are easy to add without code changes (file-based packs under allowlisted roots).

## Dependencies

- Requires `server-plugin-llama-cpp-foundation`.
