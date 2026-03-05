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
- Operators may override per-run timeouts (case/run) for slow configurations; defaults stay conservative.
- Visuals: none.
- Prompt scenarios and calibration policies (small/medium/large tuning prompts; fit-min-ctx vs prune)
  are deferred until after v0.0.1 so Sweep MVP remains focused.
- Post v0.0.1 engine hardening: mixed-GPU SSH hosts must use explicit GPU selection and should validate selector values up front.
  - Accept `--device none`.
  - Accept comma-separated `--device` identifiers in a single argv token (example: `ROCm0,ROCm1`).
  - Only treat `--split-mode` as satisfying mixed-GPU safety when value is `none`.
  - When remote discovery is unavailable, fail open but log that validation was skipped.

## Assumptions

- `server-plugin-llama-cpp-foundation` produces `runs/{runId}/result.json` with required fields per `runs/result-schema`.
- The server already has a stable run state machine and can expose read APIs for run artifacts.

## Risks

- Context file ingestion can become an arbitrary file-read vector if paths are not confined.
- Token budgets are hard without a tokenizer; early approximation must be clearly documented.

## Success Criteria

- A completed run reliably produces `result.json`, `cases.csv`, and `summary.md` derived from the same data.
- Workload packs are easy to add without code changes (at least for file-based packs under an allowlisted root).
