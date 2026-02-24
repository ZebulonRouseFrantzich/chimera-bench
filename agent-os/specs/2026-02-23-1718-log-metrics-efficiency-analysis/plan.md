# Spec 4 - Log Metrics Efficiency Analysis

## Objective

Extract deeper performance signals from engine logs and classify inefficient configurations.

## Context carried from shaping

- Log tapping is required because not all useful metrics are available in OpenAI-compatible API responses.
- Acceptance ratio is an important efficiency signal; low acceptance should be explicitly surfaced.
- This phase captures practical, high-value metrics first rather than complete methodology parity.

## Deliverables

- Structured log tapping pipeline (stdout/stderr capture + parsing stages).
- Metric extractors for prompt eval speed, TTFT, total latency, and speculative acceptance where available.
- Confidence/error reporting for parse coverage.
- Efficiency heuristics and flags (for example acceptance ratio thresholds).
- Inclusion of parsed metrics in run artifacts and exports.

## Standards applied

- `agent-os/standards/plugins/engine-interface.md`
- `agent-os/standards/runs/result-schema.md`

## Reference implementations

- draftbench (acceptance-ratio framing and sweep analysis): `https://github.com/alexziskind1/draftbench`
- llama-benchy (latency and realistic workload orientation): `https://github.com/eugr/llama-benchy`
- llama.cpp (engine log source characteristics): `https://github.com/ggml-org/llama.cpp`

## Non-goals

- Building full statistical modeling or anomaly detection systems.
- Supporting every engine's log format in this phase.

## Implementation tasks

1. Define metric event model and parser interfaces.
2. Implement `llama.cpp` parser rules and fallback behavior.
3. Add efficiency scoring and threshold flags.
4. Integrate parsed metrics into `result.json`, CSV, and summary markdown.
5. Add parser tests with real log fixtures.

## Exit criteria

- Sweep outputs include reliable deep metrics and clearly flag inefficient parameter regions.

## Dependencies

- Requires `server-plugin-llama-cpp-foundation`, `workload-packs-and-exports`, and `sweep-engine-run-orchestration`.
