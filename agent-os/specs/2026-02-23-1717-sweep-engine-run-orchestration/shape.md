# Sweep Engine Run Orchestration - Shaping Notes

## Scope

- Define a sweep configuration model that expands into many benchmark cases.
- Implement deterministic matrix expansion and case identity hashing.
- Execute sweeps with clean engine restarts between cases.
- Persist intermediate state to support resume and cancellation.
- Emit typed progress events so clients can monitor long runs.

## Decisions

- Deterministic by default: sweep expansion order and case IDs must be stable.
- Isolation by default: restart the engine between cases to reduce cache contamination.
- Single active sweep/run at a time initially (can be relaxed later).
- Persist intermediate state as files under the run directory (no DB).
- Visuals: none.

## Assumptions

- `server-plugin-llama-cpp-foundation` provides a run state machine, run SSE, and artifact persistence.
- `workload-packs-and-exports` provides workload packs and export generation.

## Risks

- Combinatorial explosion; mitigations include max-case caps, sampling, and explicit axes constraints.
- Resume/cancel correctness requires careful state persistence and idempotent transitions.

## Success Criteria

- A sweep definition expands deterministically into cases, runs to completion with restarts, supports cancellation/resume, and produces consistent artifacts.
