# Tuning Workload MVP - Shaping Notes

## Scope

- Add exactly one built-in workload intended for sweep tuning in v0.0.1.

## Decisions

- Single prompt only (one case) for the MVP.
- No file-based packs or context ingestion in v0.0.1.
- IDs are stable and explicit (`workloadId`, `promptId`, `caseId`).

## Context

- Visuals: none.
- References: `src/server/runs/starter-workload.ts` (built-in workload pattern).
- Roadmap sequencing: `agent-os/product/roadmap.md`.

## Risks

- If the prompt is too short, it will not meaningfully stress KV allocations.
- If the prompt is too long, it may be awkward to embed directly in source; prefer a deterministic generator when needed.

## Success Criteria

- A sweep can reuse this workload to compare `llama-server` launch configurations without requiring workload pack plumbing.
