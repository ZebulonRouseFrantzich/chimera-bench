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
- Export pipeline derived from `runs/{runId}/result.json`:
  - `manifest.json`
  - `cases.csv`
  - `cases.ndjson`
  - `summary.md`
  - `bundle.tgz`
- Stable mapping between run schema fields and export columns/sections.
- Workload APIs (route group: `/workloads`) for listing and selecting workloads.
- Workloads reload API to rescan filesystem packs without restart.
- Export read APIs (route group: `/exports`) for retrieving artifacts:
  - raw `result.json` and `manifest.json`
  - raw engine logs when available (`engine.stdout.log`, `engine.stderr.log`)
  - CSV/NDJSON/markdown exports
  - shareable bundle
- NDJSON case export for large sweeps.
- Single-file export bundle for sharing (result + exports).
- Persist a run artifact manifest (`runs/{runId}/manifest.json`) and provide an artifacts index API so clients can discover available artifacts.
- Workload file safety: allowlist workload pack roots via `CHIMERA_WORKLOAD_ROOTS`.
- Persist workload digests (pack + referenced context docs) into `result.json` and exports for reproducibility.
- Persist model digests (where available) into `result.json` and exports for reproducibility.
- Standardize engine log artifact filenames so v0.2.0 deep-metrics parsing can depend on stable inputs.
- CLI workload pack validator for pack authors.
- OpenAPI/SDK artifacts updated and drift-free when routes/schemas change.

## Standards applied

- `agent-os/standards/server/api-conventions.md`
- `agent-os/standards/runs/result-schema.md`
- `agent-os/standards/runs/artifact-store.md`
- `agent-os/standards/runs/built-in-workload-hardening.md`
- `agent-os/standards/global/sanitization-and-safe-errors.md`
- `agent-os/standards/server/log-line-format.md`
- `agent-os/standards/global/ttl-cache-and-inflight-dedupe.md`
- `agent-os/standards/global/time-based-testing.md`
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
  - CSV and NDJSON should repeat essential run-level metadata on every row/line so results can be concatenated across runs and engines.
  - Markdown summary must include sweep ranking and aggregates when present in `result.json`.


## Parallelizable workstreams

- Workstream A (Tasks 2-4): workload IDs, pack schema, registry, and `/workloads` routes.
  - Coordination point: define shared constants once (workloadId regex, budgets).
- Workstream B (Tasks 5-6): context ingestion + provenance/digest persistence.
  - Low conflict with A; integrates at “select workload at run creation” seam.
- Workstream C (Task 7): exports and `/exports` routes.
  - Renderer modules (CSV/NDJSON/summary/bundle) can be developed in parallel behind a single orchestration owner.
- Workstream D (Tasks 9-10): CLI validator + fixtures/tests.
  - Task 9 depends on Task 3; Task 10 should land after export formats stabilize.
- Workstream E (Task 11): bounded engine logs.
  - Can be parallel with Task 7; integrates via manifest + `/exports` allowlist.

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
  - Introduce the tuning workload as `tuning.v1`.
    - Update its `caseId` and `promptId` to match the new workload ID prefix (`tuning.v1.`).
    - Re-baseline any regression hash tests that intentionally lock the prompt contract.
  - Back-compat for existing automation:
    - Treat `tuning.v0_0_1` as a deprecated alias of `tuning.v1` for at least one release line (v0.1.x).
    - Runs created using the alias must persist the canonical ID (`tuning.v1`) in `result.json` and exports.
- Default workload selection:
  - Add a new high-quality starter pack as `starter.v2` (do not mutate `starter.v1`).
  - Set the server default workload ID to `starter.v2` for v0.1.0.
  - Keep `starter.v1` and `tuning.v1` selectable explicitly.
- `starter.v2` content and intent:
  - Include 4 prompts designed to resemble real technical usage:
    - TypeScript bugfix + tests (small but non-trivial).
    - API/architecture explanation with explicit trade-offs.
    - Data transformation task with structured output requirements.
    - Multi-turn follow-up where the assistant must carry constraints across turns.
  - Every prompt must be deterministic, bounded, and regression-locked per `runs/built-in-workload-hardening`.
  - Prompt IDs and case IDs must be stable and prefixed with `starter.v2.`.
- Documentation:
  - Update any curl examples in specs that reference `tuning.v0_0_1` to `tuning.v1`.
  - Call out the default workload change (`starter.v2`) as a compatibility note in the v0.1.0 release notes.
  - When the server chooses the default workload because the client omitted `workloadId`, emit a structured log line (include `defaultWorkloadId` and `requestedWorkloadId=unset`).

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
  - `workloadId` regex enforcement:
    - The regex requirement applies to pack definitions (`workload.json`).
    - Run creation must validate that the requested `workloadId` exists in the registry and return a stable `WORKLOAD_NOT_FOUND` error when missing.
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
  - Normalize both sources into the same internal pack shape and validate built-ins with the same zod schema used for filesystem packs.
- `CHIMERA_WORKLOAD_ROOTS` parsing:
  - Prefer one delimiter across platforms if feasible, but for correctness use OS delimiter via `node:path` `delimiter`.
    - Linux/macOS: `:`
    - Windows: `;`
  - Rationale: aligns with existing `CHIMERA_MODEL_ROOTS` parsing and avoids Windows drive-letter ambiguity.
- Trust + safety model:
  - `CHIMERA_WORKLOAD_ROOTS` is operator-controlled and must point to trusted directories.
  - Workload packs are treated as untrusted inputs within those trusted roots (validate and bound everything).
  - Defense-in-depth (POSIX): reject workload roots that resolve under `/proc`, `/sys`, or `/dev`.
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
    - `?includePrompts=1`: include prompt message bodies.
      - Hard response ceiling: 2 MiB (UTF-8 bytes) for the JSON payload.
      - If the response would exceed the ceiling, return HTTP 413 with a stable `RESPONSE_TOO_LARGE` error (do not truncate silently).
  - `POST /workloads/reload` (enveloped JSON): rescan `CHIMERA_WORKLOAD_ROOTS` and refresh the in-memory index.
    - Response includes counts (example: discovered packs, skipped invalid packs, duplicate-id skips).
    - Auth required.
    - Add a simple cooldown (minimum 5s between reloads) and in-flight dedupe so concurrent callers do not trigger duplicate scans.
      - Within the cooldown window, return HTTP 429 with a stable `WORKLOADS_RELOAD_COOLDOWN` error and a `retryAfterMs` hint.
  - Do not expose absolute filesystem paths in API responses.
- Observability:
  - Log one structured line per scan/reload with pack counts, skipped counts, and elapsedMs (per `server/log-line-format`).
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
  - Deterministic, per-file truncation.
  - Read at most `maxBytesPerContextFile` from each file (UTF-8 bytes); if the file is larger, truncate and append the stable marker `\n...[truncated]...\n`.
  - Enforce `maxCombinedContextBytesPerPrompt` by limiting each context file read to the remaining budget; when the combined budget is exhausted, omit remaining context files and append a stable marker indicating omission.
- Injection format:
  - Prepend a system message containing context docs with explicit markers:
    - `BEGIN_CONTEXT <relative_path>`
    - `END_CONTEXT <relative_path>`
  - Preserve pack message ordering after the injected system message.
- Token-fit preflight alignment:
  - Ensure the string used for preflight token estimation includes the injected context.
  - Keep behavior deterministic (same pack -> same injected message text).
- Notes (security):
  - Perform realpath-based containment checks immediately before reading each file.
  - Treat symlink/TOCTOU hardening as best-effort; rely on trusted workload roots for the primary safety boundary.
- Observability:
  - Log context ingestion with bytes, truncated flags, and elapsedMs (per `server/log-line-format`).

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


### Task 6: Persist Workload + Model Digests and Provenance into `result.json`

- Goal: runs remain comparable even if a filesystem pack changes later.
- Invariant:
  - Snapshot provenance at run creation time (or immediately after pack selection) and persist it with the run.
  - Exports must use only persisted run artifacts (`result.json` and derived files) and must not re-resolve workload packs from the live registry.
- Compute a workload digest for every run:
  - Base input: canonicalized `workload.json`.
  - Include referenced context docs:
    - For every `contextFiles[]` actually used by executed prompts, compute `sha256(contentsUsed)`.
      - `contentsUsed` is the exact UTF-8 bytes injected into the prompt (post-truncation / post-budget enforcement).
    - Record only relative paths + hashes + byte sizes (never absolute paths).
    - Include a `truncated` boolean when the injected content differs from the full file contents.
  - Keep ordering deterministic (sort by relative path).
- Compute a model digest when available:
  - If the orchestrator can read model bytes locally (local targets, and any model identifiers that resolve to a local file), capture:
    - `bytes`
    - `digestSha256` (optional; see performance note below)
  - If the model identifier refers to a remote path (SSH target), set digest fields to `null` with a stable `unavailableReason`.
  - Performance note: computing `sha256` over multi-GB model files is expensive. Use a deterministic cache keyed by `{ resolvedPath, bytes, mtimeMs }` so repeated runs do not re-hash unchanged files.
  - Trust note: model roots must be operator-controlled and not writable by untrusted users.
  - Add an operator/debug option to bypass/disable the model digest cache for re-verification (for example: `CHIMERA_MODEL_DIGEST_CACHE_MAX_ENTRIES=0`).
- Observability:
  - Log workload digest computation and model digest cache hit/miss with stable keys (per `server/log-line-format`).
- Persist provenance into `runs/{runId}/result.json`:
  - Add a top-level `workloadPack` object (additive; keep existing `workloadId` top-level field):
    - `schemaVersion` (pack schema version)
    - `version` (from `workload.json`)
    - `source` (`built-in` | `filesystem`)
    - `digestSha256`
    - `contextDigests` (array of `{ path, sha256, bytes, truncated }`)
  - Add a top-level `modelInfo` object (additive; keep existing `model.identifier`):
    - `resolvedPath` (optional; omit for SSH targets)
    - `bytes` (nullable)
    - `mtimeMs` (nullable)
    - `digestSha256` (nullable)
    - `unavailableReason` (optional string when digests are null)
- Surface provenance in exports:
  - `summary.md` should include `workloadId` + `workloadPack.digestSha256` and, when available, `modelInfo.digestSha256`.
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

4) Model digest caching:
  - Run two identical runs against the same local model file.
  - Confirm the second run does not re-hash (observe logs) and `modelInfo.digestSha256` is stable.


### Task 7: Implement Exports (`cases.csv`, `summary.md`, `cases.ndjson`, `bundle.tgz`) + `/exports` APIs

- Export behavior:
  - Generate exports from `runs/{runId}/result.json`:
    - `runs/{runId}/manifest.json`
    - `runs/{runId}/cases.csv`
    - `runs/{runId}/summary.md`
    - `runs/{runId}/cases.ndjson`
    - `runs/{runId}/bundle.tgz`
  - Write atomically (temp + rename) and keep outputs deterministic.
    - Create temp files in the destination run directory to preserve atomic rename semantics (do not write to a different filesystem like `/tmp`).
  - Provide idempotent regeneration: safe to re-run without semantic drift.
  - Generate exports automatically on run completion.
  - If an export is requested before it exists, generate on-demand from `result.json`.
    - Use in-flight dedupe (single-flight) keyed by `{ runId, artifactName }` so concurrent requests do not start duplicate generation.
    - Follow `global/ttl-cache-and-inflight-dedupe`.
  - Source validation:
    - Parse and schema-validate `result.json` before generating derived exports.
    - If validation fails, do not write exports; return HTTP 500 with a safe, stable error (example code: `EXPORT_SOURCE_INVALID`) and log `logReason` with details.
  - Observability:
    - Log export generation (artifactName, bytes, elapsedMs, onDemand=0|1) per `server/log-line-format`.
- CSV mapping:
  - Rows correspond 1:1 with result-schema cases.
  - Headers use `snake_case`.
  - Repeat essential run-level fields on every row:
    - `run_id`, `schema_version`, `created_at`
    - `orchestrator_version`, `engine_id`, `engine_version`
    - `target`, `target_profile_id`
    - `model_identifier`, `model_digest_sha256`
    - `workload_id`, `workload_digest_sha256`
  - Include `metricsExtra` as `metrics_extra_json` when present.
  - Include `engine_args_json` and `request_params_json` so sweep case configs can be reconstructed.
  - Stability contract:
    - Columns are append-only. Do not rename/reorder/remove columns within a schema version.
    - If columns are added in future versions, append at the end.
- NDJSON mapping:
  - One JSON object per line.
  - Stream the response (do not buffer the entire file in memory).
  - Each line includes:
    - stable run-level metadata fields
    - the full case record (using the same key names as `result.json` case objects)
- Bundle behavior:
  - `bundle.tgz` includes at minimum:
    - `result.json`
    - `manifest.json`
    - `cases.csv`
    - `cases.ndjson`
    - `summary.md`
  - Bundle generation is deterministic (byte-stable for identical inputs):
    - Stable file order.
    - Deterministic tar headers for every entry:
      - `mtime=0`, `uid=0`, `gid=0`, fixed `mode` (for example `0644`), empty owner/group names.
    - Deterministic gzip header:
      - `mtime=0`, no filename, stable OS byte (use `255` / unknown).
  - Logs are excluded from the default bundle.
    - Support explicit inclusion via `GET /exports/runs/:runId/bundle.tgz?includeLogs=1`.
    - When included, logs must appear at stable paths in the archive (`engine.stdout.log`, `engine.stderr.log`) and use a stable file order.
- API surfaces (raw, not enveloped):
  - These routes are intentionally an allowlist of known artifacts.
  - Do not implement a generic `:filename` route.
  - `GET /exports/runs/:runId/result.json` -> `application/json`
  - `GET /exports/runs/:runId/manifest.json` -> `application/json`
  - `GET /exports/runs/:runId/engine.stdout.log` -> `text/plain`
  - `GET /exports/runs/:runId/engine.stderr.log` -> `text/plain`
  - `GET /exports/runs/:runId/cases.csv` -> `text/csv`
  - `GET /exports/runs/:runId/summary.md` -> `text/markdown`
  - `GET /exports/runs/:runId/cases.ndjson` -> `application/x-ndjson`
  - `GET /exports/runs/:runId/bundle.tgz` -> `application/gzip`
  - Include `Content-Disposition` filenames.
    - Filenames must be ASCII-safe and include the `runId` (example: `run_<runId>_cases.csv`).
  - Error responses:
    - Success responses return raw artifact bytes.
    - Errors return standard enveloped JSON errors with safe messages (content-type `application/json`).
- OpenAPI/SDK:
  - Register `/exports` paths with correct content types.
  - Regenerate OpenAPI/SDK artifacts.

#### Manual Testing

1) Run a benchmark to completion (any workload).

2) Confirm files exist:

```bash
ls -la runs/RUN_ID/result.json runs/RUN_ID/manifest.json runs/RUN_ID/cases.csv runs/RUN_ID/summary.md runs/RUN_ID/cases.ndjson runs/RUN_ID/bundle.tgz
```

3) Fetch via API and confirm content types:

```bash
curl -i -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/exports/runs/RUN_ID/result.json
curl -i -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/exports/runs/RUN_ID/manifest.json
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

6) Path traversal negative checks (should 404):

```bash
curl -i -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/exports/runs/RUN_ID/..%2f..%2fetc%2fpasswd
curl -i -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/exports/runs/RUN_ID/unknown.file
```


### Task 8: Add Run Artifacts Index API (`GET /runs/:runId/artifacts`)

- Add an enveloped JSON endpoint that returns a run's artifact manifest.
- Manifest source of truth:
  - `runs/{runId}/manifest.json` (generated by Task 7; may be generated on-demand if missing).
- Manifest shape:
  - `schemaVersion`
  - `runId`
  - `artifacts[]`: `{ name, contentType, bytes, sha256, url }`
  - Keep ordering deterministic by sorting `name`.
- Response shape (example):
  - Return the manifest contents under `data`.
  - Include at least: `result.json`, `manifest.json`, `cases.csv`, `cases.ndjson`, `summary.md`, `bundle.tgz`.
  - Include engine log artifacts when present: `engine.stdout.log`, `engine.stderr.log`.
- Do not expose absolute filesystem paths.
- OpenAPI/SDK:
  - Register the endpoint in OpenAPI and regenerate artifacts.

#### Manual Testing

1) Complete a run.

2) Fetch the index:

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/runs/RUN_ID/artifacts
```

3) Confirm the manifest lists expected artifacts with stable ordering and correct URLs.


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
    - Prefer a fixture generated by `server-plugin-llama-cpp-foundation` and validate it against `runs/result-schema`.
  - golden `cases.csv`, `cases.ndjson`, `summary.md` outputs.
- Fail tests on output drift unless explicitly updated.
- Add a documented, deterministic regeneration workflow for goldens (helper script or test harness), so updates are intentional.
- Add tests for:
  - workload pack validation and path confinement
  - `/workloads` responses (includePrompts gating, size ceiling, reload)
  - workload digest persistence (`workloadPack.digestSha256`) and model digest persistence (`modelInfo.digestSha256`)
  - `runs/{runId}/manifest.json` shape and deterministic ordering
  - engine log artifacts (bounded persistence + redaction) and `/exports` log routes
  - `/exports` responses (raw content types, bundle contents, run-level join columns)
  - bundle determinism (two generations produce identical bytes for identical inputs)
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


### Task 11: Capture Bounded Engine Logs as Run Artifacts

- Goal: preserve enough engine output for debugging and for v0.2.0 deep-metrics parsing.
- Persist bounded log artifacts for each run:
  - `runs/{runId}/engine.stdout.log`
  - `runs/{runId}/engine.stderr.log`
- Log capture rules:
  - Capture output from engine subprocesses / SSH-managed sessions when available.
  - Apply hard size caps (truncate with a stable marker) to avoid disk blowups.
  - Sanitize control characters.
  - Redact secrets (best-effort) before persistence.
    - Baseline patterns to redact (case-insensitive where applicable):
      - `Authorization:` headers (including `Bearer` tokens)
      - `CHIMERA_SERVER_PASSWORD`
      - `api[-_ ]?key`
      - SSH private key markers (`BEGIN OPENSSH PRIVATE KEY`, `BEGIN RSA PRIVATE KEY`)
    - Document that redaction is not complete; operators should avoid passing secrets via args/env that engines may print.
  - Provide an operator option to disable log persistence entirely (when disabled, omit from manifest and `/exports` routes return 404).
- Manifest + indexing:
  - Include these artifacts in `runs/{runId}/manifest.json` and in `GET /runs/:runId/artifacts` when present.
- Export access:
  - Expose raw downloads via `/exports` so remote clients can fetch logs when debugging.
  - Do not include logs in the default shareable `bundle.tgz`.
    - Include logs only when explicitly requested via `?includeLogs=1` on the bundle endpoint.

#### Manual Testing

1) Complete a run.

2) Confirm the log artifacts exist:

```bash
ls -la runs/RUN_ID/engine.stdout.log runs/RUN_ID/engine.stderr.log
```

3) Confirm logs are accessible via API (once `/exports` log routes exist):

```bash
curl -i -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/exports/runs/RUN_ID/engine.stdout.log
curl -i -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/exports/runs/RUN_ID/engine.stderr.log
```

4) Confirm common secrets are not present in persisted logs:

```bash
rg -n "Authorization|CHIMERA_SERVER_PASSWORD|api[-_ ]?key" runs/RUN_ID/engine.*.log
```


## Follow-ups (engine hardening)

### Task 12: Validate Explicit GPU Selector Values for Mixed-GPU SSH Targets

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

### Task 13: Add Scenario-Style Prompt Variants to Workload Packs

- Add optional scenario variants (example: `small`, `medium`, `large`) with stable IDs.
- Each scenario selects a fixed `messages` bundle with stable identifiers.
- Ship tuning workloads with multiple scenario variants designed to fit common context windows.

#### Manual Testing

1) Create a pack with scenario variants.

2) Confirm `/workloads/:workloadId` exposes scenario metadata and that prompt selection (once implemented by the sweep spec) can target scenarios deterministically.


### Task 14: Add Prompt Calibration Policy Support for Sweeps

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


### Task 15: Reduce Sweep Restart Churn for Guaranteed Prompt-Overflow Cases

- Add deterministic preflight bucketing keyed by effective prompt/scenario + `--ctx-size`.
- When a bucket fails prompt-fit preflight, mark all matching cases as `VALIDATION_PROMPT_TOO_LARGE` without launching engine sessions.
- Preserve stable case ordering and artifact determinism.

#### Manual Testing

1) Run a sweep where every case is known oversize and confirm no repeated engine startup loops.

2) Run a mixed sweep and confirm only fit-capable buckets launch engine sessions.


## Follow-ups (operations)

### Task 16: Add Run Artifact Retention Policy

- Goal: prevent long-running servers from filling disk with exports and logs.
- v0.1.0 policy:
  - Document that retention/cleanup is operator-managed (no automatic deletion).
- Follow-up implementation:
  - Add optional server-side retention (TTL and/or max-bytes) with a safe, observable cleanup routine.
  - Provide a dry-run mode and structured logs for deletions.

#### Manual Testing

1) Simulate many runs and confirm the retention routine deletes only eligible artifacts and never escapes the artifact root.


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
