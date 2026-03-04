# Tuning Workload MVP - Shaping Notes

## Scope

- Add exactly one built-in workload intended for sweep tuning in v0.0.1.

## Decisions

- Single prompt only (one case) for the MVP.
- No file-based packs or context ingestion in v0.0.1.
- IDs are stable and explicit (`workloadId`, `promptId`, `caseId`).
- Prompt is generated deterministically in code (no external files).
- Prompt targets ~8k tokens via `estimateTokenCount()` (rough whitespace estimate) to stress KV-cache without being absurdly large.
- Built-in prompt text is hard-capped (<= 128KiB) so edits cannot silently balloon.
- Primary KV/OOM stress knob is `--ctx-size` (passed via `engine.serverArgs`), not prompt size.
- SSH mixed-GPU safety: if a remote target exposes multiple GPU devices, require explicit GPU selection flags in `engine.serverArgs` (for example `--device ROCm0`, `--main-gpu 0`, or `--split-mode none`).
- Mixed-GPU guidance should suggest both `--device` and `--main-gpu`; when help output exposes concrete candidates, include them in user-visible validation guidance and server console logs.
- `--split-mode` only counts as mixed-GPU guard compliance when value is `none`; other split-mode values still require explicit `--device` or `--main-gpu`.
- `--device` and `--main-gpu` must include non-empty values to satisfy mixed-GPU guard compliance.
- Remote `llama-server --help` discovery is shared/cached across strict flag validation and mixed-GPU hints so one cold-path probe serves both.
- Remote help cache uses TTL plus a fixed max-entry bound to avoid unbounded growth in long-running servers.
- Keep cache timing on `Date.now()` (short-lived TTL freshness checks); no monotonic-clock migration required for this MVP.
- Full selector-value membership validation against discovered candidates is deferred to post-v0.0.1 follow-up work.

## Context

- Visuals: none.
- References: `src/server/runs/starter-workload.ts` (built-in workload pattern).
- Roadmap sequencing: `agent-os/product/roadmap.md`.

## Risks

- If the prompt is too short, it will not meaningfully stress KV allocations.
- If the prompt is too long, it may be awkward to embed directly in source; prefer a deterministic generator when needed.
- The default case timeout (2 minutes) may be too short for large-context + long-decode tuning; operator docs should recommend raising `timeouts.caseMs` for sweeps.
- If operators use a large `max_tokens` while also sweeping large `--ctx-size` values, iteration time can grow quickly; recommend a two-pass approach (boundary pass then throughput pass).
- Mixed-GPU remote hosts can be unstable when `llama-server` auto-selects multiple devices; require explicit GPU selection for SSH runs.
- GPU-hint discovery may fail transiently over SSH; fail open for run validation but log explicit operator guidance when the guard is skipped.

## Success Criteria

- A sweep can reuse this workload to compare `llama-server` launch configurations without requiring workload pack plumbing.
