# Spec 4 - Sweep Engine Run Orchestration

## Objective

Automate benchmark matrices across engine flags, API params, and context depth with reproducible run control.

## Context carried from shaping

- Sweep definitions must preserve flexibility for evolving engine flags.
- Pass-through options are required so new backend flags can be tested without core schema churn.
- Engine restarts between cases are required to reduce cache contamination and improve comparability.

## Deliverables

- Sweep definition schema (axes, value sets, combinatorics controls).
- Deterministic case generation and run ordering.
- Case runner with clean engine restarts between cases to avoid cache contamination.
- Progress tracking and resumable run state.
- Typed progress events over `/event` for clients monitoring long-running sweeps.
- Aggregated run summary statistics.

## Standards applied

- `agent-os/standards/plugins/engine-interface.md`
- `agent-os/standards/runs/result-schema.md`

## Reference implementations

- OpenCode server docs: `https://opencode.ai/docs/server/`
- draftbench (multi-pass sweeps and comparative analysis framing): `https://github.com/alexziskind1/draftbench`
- llama.cpp runtime flag workflows: `https://github.com/ggml-org/llama.cpp`

## Non-goals

- SSH execution.
- Advanced log metrics parsing (handled in a later spec).
- Frontend UI work.

## Implementation tasks

1. Define sweep config model for engine args and request params.
2. Build matrix expansion and case identity hashing.
3. Implement run scheduler and restart policy.
4. Define and emit typed sweep progress events for `/event` consumers.
5. Persist intermediate state for resume/cancel behavior.
6. Generate aggregate summaries over case outputs.

## Exit criteria

- A single command/API call runs a full parameter sweep with deterministic artifacts and restart isolation.

## Dependencies

- Requires `server-plugin-llama-cpp-foundation` and `workload-packs-and-exports`.
