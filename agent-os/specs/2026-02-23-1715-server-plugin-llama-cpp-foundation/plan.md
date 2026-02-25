# Spec 1 - Server Plugin llama.cpp Foundation

## Objective

Deliver the first usable backend server with a stable engine plugin boundary and one working engine plugin (`llama.cpp`).

## Program context carried from shaping

- Use an OpenCode-style split architecture (`server` + `client`), but implement server-first.
- Follow OpenCode backend direction for this phase (Bun + TypeScript + Hono style patterns).
- Start with a small set of high-quality benchmark prompts; expand methodology later.
- Keep engine options flexible via pass-through fields so new flags do not require core code changes.
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

## Non-goals

- Web client UI.
- SSH remote execution.
- Full sweep matrix automation.
- Deep speculative metric extraction.
- Full parity with all benchmark inspiration methods in this first phase.
- Multi-user auth and billing features.

## Implementation tasks

1. Define serve command behavior and network flags from `server/api-conventions`.
2. Define API routes and envelopes, including `/global/health`, `/event`, and `/doc`.
3. Define plugin lifecycle contract from `plugins/engine-interface`.
4. Implement plugin registry and engine capability listing.
5. Implement `llama.cpp` plugin process lifecycle and readiness checks.
6. Implement single benchmark run endpoint and orchestration flow.
7. Persist run artifacts and expose read APIs.
8. Generate and validate OpenAPI/SDK artifacts.
9. Add smoke tests and operator docs.
10. If dev-only behavior gating is added, define and document `CHIMERA_BENCH_DEV` (behavior, defaults, and contributor setup updates).

## Exit criteria

- A user can start the server, submit a local `llama.cpp` run, and retrieve structured results.
