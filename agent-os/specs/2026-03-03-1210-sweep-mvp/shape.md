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
- Security hardening at creation time:
  - reject reserved/core-owned and denylisted server flags inside sweep axis fragments
  - reject reserved request param keys (`messages`, `model`, `stream`)
  - apply the same request-param node/depth/string-length budget validation used for `engine.requestParams` to each axis value
- Workload constraint for v0.0.1: sweep execution supports workloads with exactly 1 workload case.
- Keep execution single-threaded (one active run) to reduce resource risk.
- Reuse existing `run.*` SSE events; defer sweep-specific event taxonomy.
- SSE payloads must not include full per-case `engineArgs` / `requestParams` for v0.0.1.

- Progress semantics:
  - when `sweep` is present, `totalCases` must equal `plannedCases` (not workload case count)

- Hard safety cap:
  - `MAX_SWEEP_CASES = 256` server-enforced regardless of caller-provided `maxCases`

- Reliability stop condition:
  - `MAX_CONSECUTIVE_ENGINE_LIFECYCLE_FAILURES = 3` triggers failing the run and marking remaining cases failed

## Context

- Visuals: none.
- References: existing run orchestration, run store, and result schema.
- Roadmap sequencing: `agent-os/product/roadmap.md`.
- Artifact note: v0.0.1 Sweep MVP requires `runs/{runId}/result.json`; `cases.csv` + `summary.md` remain deferred.

## Risks

- Combinatorial explosion: mitigate with `maxCases` caps.
- Restart-per-case increases runtime; acceptable for tuning MVP.
- Hash-based identities require canonical JSON + JSON-serializable axis values.
- Hash stability drift: mitigate with golden hash fixtures.
- Persisting many cases can produce large artifacts; keep `maxCases` conservative.
- Existing run storage/orchestration must record per-case `engineArgs` + `requestParams` for sweeps.

## Success Criteria

- Operators can sweep `llama-server` args/params against an SSH target and quickly see rough best configs.
- Re-running the same sweep config yields identical expansion order, stable `caseId`s, and deterministic ranking.
