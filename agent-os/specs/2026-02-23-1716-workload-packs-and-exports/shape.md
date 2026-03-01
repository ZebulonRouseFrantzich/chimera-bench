# Workload Packs and Exports - Shaping Notes

## Scope

- Define a workload pack format that produces realistic, reproducible benchmark cases.
- Ship at least one built-in starter workload pack (high-quality technical prompts).
- Support optional context documents referenced by a workload pack.
- Generate portable exports (`cases.csv`, `summary.md`) derived from `runs/{runId}/result.json`.

## Decisions

- Workloads are file-based (no database).
- Workload and prompt identifiers are stable and intended for long-term comparison.
- Context files are resolved relative to the workload pack directory and must not escape it.
- Exports are derived from `result.json` only (no additional data sources), and written atomically.
- Visuals: none.

## Assumptions

- Spec 1 produces `runs/{runId}/result.json` with required fields per `runs/result-schema`.
- The server already has a stable run state machine and can expose read APIs for run artifacts.

## Risks

- Context file ingestion can become an arbitrary file-read vector if paths are not confined.
- Token budgets are hard without a tokenizer; early approximation must be clearly documented.

## Success Criteria

- A completed run reliably produces `result.json`, `cases.csv`, and `summary.md` derived from the same data.
- Workload packs are easy to add without code changes (at least for file-based packs under an allowlisted root).
