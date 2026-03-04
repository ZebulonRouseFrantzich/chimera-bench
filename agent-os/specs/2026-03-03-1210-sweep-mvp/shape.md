# Sweep MVP - Shaping Notes

## Scope

- Add a minimal sweep config to `POST /runs` with deterministic expansion.
- Execute sweep cases sequentially with engine restarts between cases.
- Persist results to JSON and include a deterministic best-to-worst ranking.

## Decisions

- Axis values are explicit lists for v0.0.1 (no `{ min, max, step }` generators).
- Deterministic expansion:
  - sort axis keys lexicographically (namespace order: `serverArgs` then `requestParams`)
  - preserve input ordering within each axis value list
  - cartesian product across axes, then apply `repetitions`
- Case identities are hash-based (future-proof):
  - compute `caseConfigId` as `sha256` of a canonical JSON representation of the inference-affecting config
  - derive `caseId` by adding a repetition suffix (ex: `.rep-1`)
- Merge semantics are simple and deterministic:
  - `engine.serverArgs` is the base argv list; sweep axis argv fragments are appended in sorted axis-key order
  - `engine.requestParams` is the base object; sweep-selected keys override base values
- Workload constraint for v0.0.1: sweep execution supports workloads with exactly 1 workload case.
- Keep execution single-threaded (one active run) to reduce resource risk.
- Reuse existing `run.*` SSE events; defer sweep-specific event taxonomy.

## Context

- Visuals: none.
- References: existing run orchestration, run store, and result schema.
- Roadmap sequencing: `agent-os/product/roadmap.md`.
- Artifact note: v0.0.1 Sweep MVP requires `runs/{runId}/result.json`; `cases.csv` + `summary.md` remain deferred.

## Risks

- Combinatorial explosion: mitigate with `maxCases` caps.
- Restart-per-case increases runtime; acceptable for tuning MVP.
- Hash-based identities require canonical JSON + JSON-serializable axis values.
- Persisting many cases can produce large artifacts; keep `maxCases` conservative.
- Existing run storage/orchestration must record per-case `engineArgs` + `requestParams` for sweeps.

## Success Criteria

- Operators can sweep `llama-server` args/params against an SSH target and quickly see rough best configs.
- Re-running the same sweep config yields identical expansion order, stable `caseId`s, and deterministic ranking.
