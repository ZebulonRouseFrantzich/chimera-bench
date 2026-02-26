# Spec - Engine Enhancements: llama.cpp Tools

## Objective

Expand `llama.cpp` engine support beyond `llama-server` while keeping the core run schema and orchestration stable.

## Why this spec exists

Spec 1 intentionally starts narrow (`llama-server`, chat-only). This follow-on spec captures enhancements to an existing engine family:

- Add a `llama-cli` execution path as a separate engine id (`llama-cpp-cli`).
- Optionally integrate `llama-bench` for throughput microbench workloads.
- Add Hugging Face model acquisition via the `hf` CLI (download to a local GGUF path), rather than using `llama-server -hf`.
- Allow user overrides for `llama-server` host/port binding when needed, with safe defaults and documented risks.

## Deliverables

- `llama-cpp-cli` plugin implementing the standard engine interface.
  - Subprocess-based execution via `llama-cli`.
  - Parameter validation via `llama-cli --help` parsing.
  - Metrics extraction from CLI output/timings.
- `llama-bench` integration (TBD: separate engine id vs a workload type).
  - Structured output ingestion (md/csv/json/jsonl) mapped into run artifacts.
- Model acquisition layer:
  - Extend `model.identifier` to support Hugging Face references.
  - Download GGUF files using the `hf` CLI to a configurable local cache.
  - Resolve to a local GGUF path used by `llama-server`/`llama-cli` runs.
- Optional `llama-server` binding overrides:
  - Support explicit host/port overrides.
  - Add operator-facing security guidance (auth, exposure, cross-talk prevention).

## Standards applied

- `agent-os/standards/plugins/engine-interface.md`
- `agent-os/standards/runs/result-schema.md`
- `agent-os/standards/server/api-conventions.md`

## Notes (research summary)

- `llama-server` provides OpenAI-compatible endpoints (`/v1/chat/completions`, `/v1/completions`, `/v1/responses`, `/v1/embeddings`) and returns a `timings` object in responses that can be used for basic benchmark metrics.
- `llama-cli` is a CLI tool for running prompts/conversations and is an attractive fit for SSH targets because it does not require opening remote ports.
- `llama-bench` is a dedicated microbenchmark tool for prompt processing / token generation throughput; it is complementary to prompt-pack workloads.

## Implementation tasks

1. Define model identifier extensions and `hf` CLI download/resolve behavior.
2. Implement `llama-cpp-cli` plugin with strict-by-default param validation and metrics parsing.
3. Define the `llama-bench` integration approach and map outputs to `runs/result-schema` artifacts.
4. Add optional `llama-server` host/port override support with safe defaults and clear docs.
5. Add docs, examples, and smoke tests for each new execution path.

## Exit criteria

- Users can run comparable benchmarks via `llama-server` or `llama-cli` through the same orchestrator APIs.
- Hugging Face identifiers resolve via the `hf` CLI to local GGUF paths, and runs remain reproducible via persisted resolved paths/metadata.
