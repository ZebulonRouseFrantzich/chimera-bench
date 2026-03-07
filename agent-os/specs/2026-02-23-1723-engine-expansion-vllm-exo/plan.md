# Engine Expansion (vLLM and exo)

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
- Cross-engine artifact parity:
  - `runs/{runId}/manifest.json` and `GET /runs/:runId/artifacts`
  - `/exports` downloads (`result.json`, `cases.csv`, `cases.ndjson`, `summary.md`, `bundle.tgz`)
  - joinable exports (run-level fields repeated per CSV row / NDJSON line)

## Standards applied

- `agent-os/standards/server/api-conventions.md`
- `agent-os/standards/plugins/engine-interface.md`
- `agent-os/standards/runs/result-schema.md`

## Reference implementations

- See `references.md`.

## Non-goals

- Achieving perfect metric parity across all engines in the first pass.
- Building custom forks of engine projects.

## Implementation tasks

1. Map each engine's launch and request model to the plugin contract.
   - For each engine (`vllm`, `exo`), document:
     - how to start the engine (CLI/module entrypoint)
     - how to specify a model
     - which OpenAI-compatible endpoints are available
     - readiness endpoint(s) and expected responses
     - how to stop the process reliably
   - Define engine IDs and capability flags (streaming, remote compatibility, metrics support).
   - Manual testing steps:
     - On a machine with the engine installed, run `--help` for the engine entrypoint and confirm required flags exist.

2. Implement plugin lifecycle and readiness checks for each engine.
   - Implement `vllm` plugin:
     - `validateEnvironment()` checks required binaries/runtime are present.
     - `start()` spawns the server bound to loopback with safe defaults.
     - `waitUntilReady()` polls a health/models endpoint with a bounded timeout.
   - Implement `exo` plugin similarly, based on the documented integration surface.
   - Ensure strict-by-default validation for `engine.serverArgs`/`engine.requestParams`.
   - Manual testing steps:
     - Start server, run a single case, and verify the run completes:
       - `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/engines` (verify new engines listed)
       - `POST /runs` using `engineId` for the new engine

3. Add parser adapters for available metrics.
   - Prefer response timings when exposed by the engine.
   - If deep metrics are unavailable, set nullable fields (`ttftMs`, `promptEvalTokensPerSecond`, `acceptanceRatio`) to `null` and record reasons in `metricsExtra`.
   - Manual testing steps:
     - Run the same workload on `llama-cpp` and on the new engine and compare which metrics are populated.

4. Validate schema/export compatibility for multi-engine runs.
    - Ensure `result.json` always conforms to required fields.
    - Ensure export generation works for the new engines:
      - `cases.csv`, `cases.ndjson`, `summary.md`, `bundle.tgz`, `manifest.json`
    - Ensure engine log artifacts are handled safely:
      - if persisted, they are bounded and redacted
    - Manual testing steps:
      - Complete a run on each engine and verify:
        - `runs/RUN_ID/result.json`
        - `runs/RUN_ID/manifest.json`
        - `runs/RUN_ID/cases.csv`
        - `runs/RUN_ID/cases.ndjson`
        - `runs/RUN_ID/summary.md`
        - `runs/RUN_ID/bundle.tgz`
      - Verify API parity:
        - `GET /runs/RUN_ID/artifacts`
        - `GET /exports/runs/RUN_ID/bundle.tgz`

5. Document caveats and unsupported features by engine.
   - Add per-engine docs:
     - install/run prerequisites
     - known limitations
     - recommended defaults
   - Provide a capability matrix comparing the engines.
   - Manual testing steps:
     - Review docs against an actual run setup and confirm they are sufficient to reproduce a run.

## Exit criteria

- Users can run comparable benchmarks on at least three engines (`llama.cpp`, `vLLM`, `exo`) through the same orchestrator API.

## Dependencies

- Requires `server-plugin-llama-cpp-foundation`, `workload-packs-and-exports`, `sweep-engine-run-orchestration`, and `log-metrics-efficiency-analysis`.
