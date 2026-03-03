# Sweep MVP - Shaping Notes

## Scope

- Add a minimal sweep config and deterministic expansion.
- Execute sweep cases sequentially with engine restarts between cases.
- Persist results to JSON and include a best-to-worst ranking.

## Decisions

- Axis values are explicit lists for v0.0.1.
- Keep execution single-threaded (one active run) to reduce resource risk.
- Defer resume/state persistence and sweep-specific event taxonomy until after v0.0.1.

## Context

- Visuals: none.
- References: existing run orchestration and result schema.
- Roadmap sequencing: `agent-os/product/roadmap.md`.

## Risks

- Combinatorial explosion: mitigate with `maxCases` caps.
- Restart-per-case increases runtime; acceptable for tuning MVP.

## Success Criteria

- Operators can sweep `llama-server` args/params against an SSH target and quickly see rough best configs.
