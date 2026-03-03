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

## Context

- Visuals: none.
- References: `src/server/runs/starter-workload.ts` (built-in workload pattern).
- Roadmap sequencing: `agent-os/product/roadmap.md`.

## Risks

- If the prompt is too short, it will not meaningfully stress KV allocations.
- If the prompt is too long, it may be awkward to embed directly in source; prefer a deterministic generator when needed.
- The default case timeout (2 minutes) may be too short for large-context + long-decode tuning; operator docs should recommend raising `timeouts.caseMs` for sweeps.
- If operators use a large `max_tokens` while also sweeping large `--ctx-size` values, iteration time can grow quickly; recommend a two-pass approach (boundary pass then throughput pass).

## Success Criteria

- A sweep can reuse this workload to compare `llama-server` launch configurations without requiring workload pack plumbing.
