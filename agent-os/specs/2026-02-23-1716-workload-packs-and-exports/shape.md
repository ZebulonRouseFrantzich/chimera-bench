# Workload Packs and Exports - Shaping Notes

## Scope

- Define a workload pack format that produces realistic, reproducible benchmark cases.
- Ship built-in workload packs with standardized IDs (`type.vN`) and stable prompt/case identifiers.
- Support optional context documents referenced by a workload pack with strict filesystem confinement.
- Persist workload provenance (pack + context digests) into `runs/{runId}/result.json` for reproducibility.
- Generate portable exports (`cases.csv`, `cases.ndjson`, `summary.md`, `bundle.tgz`) derived from `runs/{runId}/result.json`.
- Expose discovery/read APIs:
  - `/workloads` for listing packs and prompt IDs
  - `/runs/:runId/artifacts` for indexing available artifacts
  - `/exports` for reading derived artifacts
- Provide a CLI validator for workload pack authors.
- Keep OpenAPI and generated SDK artifacts in sync with route/schema changes.

## Decisions

- Workloads are file-based (no database).
- Built-in workload IDs are standardized to `type.vN` (example: `starter.v1`, `tuning.v1`).
  - When a built-in workload changes, publish a new ID with `v{N+1}`.
- `CHIMERA_WORKLOAD_ROOTS` is an allowlist of workload pack root directories.
  - Parsing uses OS delimiter via `node:path` `delimiter` (":" on Linux/macOS, ";" on Windows).
- Context files are resolved relative to the workload pack directory and must not escape it.
  - Use realpath-based confinement to prevent symlink escapes.
- `/workloads` returns metadata by default; prompt bodies are only included with `?includePrompts=1` and a response-size ceiling.
- `/workloads/reload` refreshes the in-memory pack index without requiring a server restart.
- `result.json` persists workload provenance and digests (no absolute paths).
- Exports are derived from `result.json` only (no additional data sources), written atomically, and served as raw files.
  - `GET /exports/runs/:runId/cases.csv` -> `text/csv`
  - `GET /exports/runs/:runId/cases.ndjson` -> `application/x-ndjson`
  - `GET /exports/runs/:runId/summary.md` -> `text/markdown`
  - `GET /exports/runs/:runId/bundle.tgz` -> `application/gzip`
- `/runs/:runId/artifacts` returns an enveloped index of available artifacts (no filesystem paths).
- v0.1.0 implements this spec alongside `agent-os/specs/2026-02-23-1717-sweep-engine-run-orchestration/`.
  Workload prompt IDs must be stable and discoverable so sweeps can select prompts deterministically.

## Assumptions

- `server-plugin-llama-cpp-foundation` produces `runs/{runId}/result.json` with required fields per `runs/result-schema`.
- The server already has a stable run state machine, artifact persistence, and SSE routes for run lifecycle.
- OpenAPI/SDK generated artifacts are committed and drift-checked via `bun run openapi:check`.

## Risks

- Context file ingestion can become an arbitrary file-read vector if paths are not confined.
- Large prompt/context bodies can cause memory pressure; enforce budgets and response size ceilings.

## Success Criteria

- A completed run reliably produces `result.json`, `cases.csv`, `cases.ndjson`, `summary.md`, and `bundle.tgz` derived from the same data.
- Workload packs are easy to add without code changes (file-based packs under an allowlisted root).
