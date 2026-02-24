# Spec 9 - Engine Expansion (vLLM and exo)

## Objective

Add additional engine plugins after the core system proves stable with `llama.cpp`.

## Context carried from shaping

- `llama.cpp` is the first supported engine, but the architecture must intentionally grow to more backends.
- Plugin isolation is the mechanism that keeps engine-specific complexity out of core orchestration.
- Cross-engine comparability is valuable even when metric parity is imperfect.

## Deliverables

- `vLLM` plugin implementing the standard engine interface.
- `exo` plugin implementing the standard engine interface.
- Capability matrix comparing plugin support (metrics, streaming, remote compatibility, known limitations).
- Engine-specific docs and configuration examples.

## Standards applied

- `agent-os/standards/plugins/engine-interface.md`
- `agent-os/standards/runs/result-schema.md`

## Reference implementations

- vLLM project: `https://github.com/vllm-project/vllm`
- exo project: `https://github.com/exo-explore/exo`
- `llama.cpp` baseline plugin reference target: `https://github.com/ggml-org/llama.cpp`

## Non-goals

- Achieving perfect metric parity across all engines in the first pass.
- Building custom forks of engine projects.

## Implementation tasks

1. Map each engine's launch and request model to the plugin contract.
2. Implement plugin lifecycle and readiness checks for each engine.
3. Add parser adapters for available metrics.
4. Validate schema/export compatibility for multi-engine runs.
5. Document caveats and unsupported features by engine.

## Exit criteria

- Users can run comparable benchmarks on at least three engines (`llama.cpp`, `vLLM`, `exo`) through the same orchestrator API.

## Dependencies

- Requires `server-plugin-llama-cpp-foundation`, `workload-packs-and-exports`, `sweep-engine-run-orchestration`, and `log-metrics-efficiency-analysis`.
