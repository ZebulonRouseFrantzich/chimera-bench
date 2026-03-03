# Engine Enhancements: llama.cpp Tools

## Objective

Expand `llama.cpp` engine support beyond `llama-server` while keeping the core run schema and orchestration stable.

## Why this spec exists

`server-plugin-llama-cpp-foundation` intentionally starts narrow (`llama-server`, chat-only). This follow-on spec captures enhancements to an existing engine family:

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

## Security and safety requirements

- Never execute subprocesses via a shell; always use argv-array spawning.
- Never log secrets (API keys, auth headers, tokens). Redact on error paths.
- Model acquisition must not allow path traversal outside the configured model roots/cache.
- For any non-loopback binding overrides, require server auth to be enabled and emit explicit operator warnings.

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
   - Add an explicit Hugging Face identifier format (example: `hf:<repo_id>#<filename>.gguf`).
   - Require the `hf` CLI to be installed and runnable; provide actionable install errors.
   - Download to a configurable cache dir (default under an XDG cache location) and store resolved metadata:
     - resolved local path, file size, and a content hash (sha256) for reproducibility.
   - Ensure downloaded/resolved GGUF paths remain compatible with `CHIMERA_MODEL_ROOTS` confinement.
   - Manual testing steps:
     - Verify missing `hf` CLI fails with an actionable error.
     - Resolve a model identifier:
       - `model.identifier: "hf:org/model-repo#model.gguf"`
       - Confirm the resolved GGUF is downloaded into the cache and the resolved local path is persisted in run metadata.
     - Re-run the same identifier and confirm it hits the cache (no re-download).

2. Implement `llama-cpp-cli` plugin with strict-by-default param validation and metrics parsing.
   - Environment validation: `llama-cli` present and runnable.
   - Validation:
     - Strict by default with an explicit permissive mode escape hatch.
     - Validate args against `llama-cli --help` (best-effort parsing with clear failure mode).
   - Execution:
      - Run per-case `llama-cli` subprocesses; capture stdout/stderr with bounded buffers.
      - Map per-case outputs to the run result schema; record errors per case.
   - Manual testing steps:
     - Run a `llama-cpp-cli` case:
       - `POST /runs` with `engineId: "llama-cpp-cli"` and a small workload.
     - Verify strict validation rejects unknown args, and permissive mode accepts them.
     - Verify `result.json` contains per-case outputs and latency fields.

3. Define `llama-bench` integration approach and map outputs to `runs/result-schema` artifacts.
   - Decide whether this is a separate engine id (`llama-cpp-bench`) or a workload type.
   - Parse `llama-bench` outputs into per-case records (or `metricsExtra`) without breaking required fields.
   - Manual testing steps:
     - Run a `llama-bench` workflow on a known model and verify parsed metrics appear in `result.json` and exports.

4. Add optional `llama-server` host/port override support with safe defaults and clear docs.
   - Keep loopback binding as the default.
   - For non-loopback binding overrides:
      - Require server auth to be enabled.
      - Emit explicit operator warnings about exposure and cross-talk.
   - Manual testing steps:
     - Attempt a non-loopback override without server auth enabled and verify it is rejected.
     - Enable auth and repeat; verify the override works and the operator warning is emitted.

5. Add docs, examples, and tests.
   - Unit tests for identifier parsing, download resolver, and validation logic.
   - Integration tests for each execution path (gated where engine binaries are required).
   - Manual testing steps:
     - Run unit/integration tests: `bun test`
     - (Optional, gated) Run engine-required tests: `CHIMERA_E2E=1 bun test`

## Exit criteria

- Users can run comparable benchmarks via `llama-server` or `llama-cli` through the same orchestrator APIs.
- Hugging Face identifiers resolve via the `hf` CLI to local GGUF paths, and runs remain reproducible via persisted resolved paths/metadata.

## Dependencies

- Requires `server-plugin-llama-cpp-foundation`.
- Remote execution integration may benefit from `ssh-remote-execution-profiles` (running `llama-cli` over SSH without opening remote ports).
