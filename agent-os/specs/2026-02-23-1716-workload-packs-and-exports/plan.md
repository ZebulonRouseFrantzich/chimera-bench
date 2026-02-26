# Spec 3 - Workload Packs and Exports

## Objective

Define realistic benchmark workloads and produce portable run outputs for analysis.

## Context carried from shaping

- The initial workload strategy is a few high-quality prompts, not a full benchmark methodology clone.
- Prompt/context inputs should resemble real technical usage patterns.
- Export artifacts remain file-based in early phases.

## Deliverables

- Workload pack format (prompt IDs, prompt text, optional context docs, expected output constraints).
- Built-in starter workload with high-quality technical prompts.
- Context injection support from local files.
- Export pipeline for `cases.csv` and `summary.md` derived from `result.json`.
- Stable mapping between run schema fields and export columns.

## Standards applied

- `agent-os/standards/runs/result-schema.md`
- `agent-os/standards/server/api-conventions.md`

## Reference implementations

- llama-benchy (real-world prompt style and TTFT emphasis): `https://github.com/eugr/llama-benchy`
- llama.cpp benchmark ecosystem baseline: `https://github.com/ggml-org/llama.cpp`

## Non-goals

- Full sweep orchestration.
- Remote execution.
- UI dashboards.

## Implementation tasks

1. Define workload config schema and validation rules.
2. Add built-in prompt pack and loader.
3. Implement context document ingestion and token-budget handling.
4. Implement CSV and markdown exporters using `runs/result-schema`.
5. Add fixture-based tests for exporter stability.

## Exit criteria

- A completed run generates consistent JSON, CSV, and markdown artifacts from the same data source.

## Dependencies

- Requires `server-plugin-llama-cpp-foundation`.
