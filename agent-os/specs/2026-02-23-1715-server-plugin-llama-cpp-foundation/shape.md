# Server Plugin llama.cpp Foundation - Shaping Notes

## Scope

- Ship a Bun + TypeScript + Hono server with a stable engine plugin boundary.
- Include one working engine plugin: `llama.cpp` via `llama-server` (chat-completions only).
- Support LAN usage safely: loopback by default, basic auth for non-loopback binds, explicit CORS allowlist.
- Persist run outputs to disk as `runs/{runId}/result.json` (CSV/MD exports deferred).

## Decisions

- Threat model: the server may be reachable from other machines (LAN). Treat API clients as untrusted unless authenticated.
- Authentication: implement HTTP basic auth via `CHIMERA_SERVER_PASSWORD` and `CHIMERA_SERVER_USERNAME` (default `chimera`).
- Exposure guardrail: refuse non-loopback binds when `CHIMERA_SERVER_PASSWORD` is unset.
- CORS: no CORS headers by default; `--cors` is an explicit allowlist (repeatable).
- Engine isolation: start a dedicated `llama-server` per run bound to `127.0.0.1`, with Web UI disabled and a per-run API key.
- Validation: the plugin owns `engine.serverArgs` and `engine.requestParams` validation; strict by default with explicit permissive opt-in.
- Model paths: `model.identifier` is a local `.gguf` file path; canonicalize it and (when configured) confine it to allowlisted model roots.
- Concurrency: Spec 1 supports a single active run at a time per server process.
- Visuals: none.

## Assumptions (must hold for Spec 1)

- `llama-server` exposes `GET /health` and `POST /v1/chat/completions` in the installed build.
- `llama-server --help` is parseable enough to extract supported flags for strict validation.

## Deferred / Out of Scope (selected)

- Workload packs and exports (`cases.csv`, `summary.md`) are deferred to Spec 3.
- Multi-engine sweeps, remote SSH execution, and client UI are not part of Spec 1.

## Success Criteria

- Operator can start the server, run a benchmark against a local GGUF model with validated params, observe progress via SSE, cancel a run, and retrieve `result.json`.
