# Spec 1 - Server Plugin llama.cpp Foundation

## Objective

Deliver the first usable backend server with a stable engine plugin boundary and one working engine plugin (`llama.cpp`).

## Program context carried from shaping

- Use an OpenCode-style split architecture (`server` + `client`), but implement server-first.
- Follow OpenCode backend direction for this phase (Bun + TypeScript + Hono style patterns).
- Start with a small set of high-quality benchmark prompts; expand methodology later.
- Keep engine options flexible via pass-through fields so new flags do not require core code changes.
- Spec 1 supports `llama-server` only (no `llama-cli` / `llama-bench` execution paths yet).
- Spec 1 uses OpenAI-compatible chat completions only (`POST /v1/chat/completions`) for case execution.
- Do not manage installation or upgrades of `llama.cpp`; only detect + validate + error with actionable messages.
- Prefer capability/parameter validation over version caps (i.e. verify the options we will call are supported).
- Model selection is core-owned; Spec 1 accepts local GGUF file paths only.
- Default runtime isolation: bind `llama-server` to loopback, disable Web UI, and avoid any preflight inference request.
- Store benchmark outputs as files (`json`, `csv`, `md`) in initial phases; no DB requirement.
- Product docs (`agent-os/product/`) are baseline guidance and can evolve as implementation decisions mature.
- Visual context: none provided; no internal reference implementation exists yet in this repo.
- Expose a documented OpenAPI 3.1 surface so future clients and SDKs can integrate without reverse-engineering routes.
- If a dev-only runtime switch becomes necessary in this phase, introduce and document `CHIMERA_BENCH_DEV` here (with an actual usage site), rather than defining it early as an unused env var.

## Deliverables

- Bun/TypeScript server package following OpenCode-style architecture.
- Headless serve command with explicit network options (`--port`, `--hostname`, repeatable `--cors`, `--mdns`, `--mdns-domain`).
- Hono API endpoints for health, engine discovery, run creation, run status, cancellation, and event streaming.
- Engine plugin contract and registry/loader.
- `llama.cpp` plugin that starts and stops `llama-server` for a benchmark run.
- Plugin-owned validation for engine-specific inputs:
  - Verify `llama-server` is installed and runnable.
  - Validate `engine.serverArgs` against the installed binary's supported flags (default: strict; opt-in permissive mode).
  - Validate `engine.requestParams` for `/v1/chat/completions` (default: strict; opt-in permissive mode).
  - Reject/override reserved launch args that core/plugin owns (model path, host/port binding, web UI, API key).
- Single-run execution path (no sweep yet) using high-quality prompts.
- Run artifact persistence (`result.json`) using `runs/result-schema`.
- OpenAPI 3.1 docs at `/doc` and generated SDK scaffolding for client use.

## Standards applied

- `agent-os/standards/server/api-conventions.md`
- `agent-os/standards/plugins/engine-interface.md`
- `agent-os/standards/runs/result-schema.md`

## Reference implementations

- OpenCode architecture: `https://github.com/anomalyco/opencode`
- OpenCode server docs: `https://opencode.ai/docs/server/`
- OpenCode server command: `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/cli/cmd/serve.ts`
- OpenCode server implementation: `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/server/server.ts`
- OpenCode plugin contract: `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/plugin/src/index.ts`
- OpenCode workspace/tooling snapshot: `https://raw.githubusercontent.com/anomalyco/opencode/dev/package.json`
- llama.cpp baseline: `https://github.com/ggml-org/llama.cpp`

## Related specs and execution sequence

1. `server-plugin-llama-cpp-foundation` (this spec)
2. `workload-packs-and-exports`
3. `sweep-engine-run-orchestration`
4. `log-metrics-efficiency-analysis`
5. `server-auth-and-ssh-secret-hardening`
6. `ssh-remote-execution-profiles`
7. `frontend-stack-decision-vue-vs-solid`
8. `client-dashboard-dual-run-mode`
9. `engine-expansion-vllm-exo`
10. `engine-enhancements-llama-cpp-tools` (future: `llama-cli`, `llama-bench`, HF model acquisition, host/port overrides)

## Non-goals

- Web client UI.
- SSH remote execution.
- Installing/building/upgrading `llama.cpp` (and any package-manager automation).
- Full sweep matrix automation.
- Deep speculative metric extraction.
- Full parity with all benchmark inspiration methods in this first phase.
- Multi-user auth and billing features.
- Supporting `llama-cli` / `llama-bench` execution paths in Spec 1.
- Hugging Face shorthand model acquisition in Spec 1 (no `-hf` flag usage); future spec will use the `hf` CLI to download to a local GGUF path.
- User overrides for `llama-server` network binding (host/port) in Spec 1.
- Optional "preflight inference request" validation mode.

## Implementation tasks

1. Define serve command behavior and network flags from `server/api-conventions`.
2. Define API routes and envelopes, including `/global/health`, `/event`, and `/doc`.
3. Define plugin lifecycle contract from `plugins/engine-interface`, including plugin-owned validation responsibilities (environment, server args, request params).
4. Implement plugin registry and engine capability listing, including an environment validation summary per engine.
5. Implement `llama.cpp` (`llama-server`) plugin process lifecycle:
   - Choose a free local port, bind to `127.0.0.1`.
   - Disable Web UI (`--no-webui`).
   - Generate a per-run API key and pass it to `llama-server` (avoid cross-talk).
   - Pass model path from core-owned `model.identifier` (local GGUF path only).
6. Implement `llama.cpp` plugin readiness checks using `GET /health` (no inference preflight).
7. Implement engine parameter validation:
   - Validate/normalize `engine.serverArgs` against `llama-server --help` output (default: strict).
   - Validate `engine.requestParams` against a `/v1/chat/completions` schema (default: strict).
   - Define a run config switch for permissive validation mode and provide opt-in permissive mode for unknown args/params.
   - Validate `model.identifier` is a readable local `.gguf` file path.
8. Implement single benchmark run endpoint and orchestration flow using `POST /v1/chat/completions`.
9. Persist run artifacts and expose read APIs; TTFT is best-effort and may be nullable until Spec 4.
10. Generate and validate OpenAPI/SDK artifacts.
11. Add smoke tests and operator docs.
12. If dev-only behavior gating is added, define and document `CHIMERA_BENCH_DEV` (behavior, defaults, and contributor setup updates).
13. TODO (future work): implement `agent-os/specs/2026-02-25-1939-engine-enhancements-llama-cpp-tools/plan.md` (`llama-cli`, `llama-bench`, host/port overrides, Hugging Face model acquisition via the `hf` CLI).

## Exit criteria

- A user can start the server, submit a local `llama-server` chat-only run with validated parameters, and retrieve structured results.
