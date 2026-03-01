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
- Threat model: server may be reachable on a LAN. Treat API clients as untrusted unless authenticated.
- Server exposure defaults: bind to loopback by default; require basic auth for non-loopback binds; no CORS headers unless explicitly allowlisted.
- Engine runtime isolation defaults: bind `llama-server` to loopback, disable Web UI, and avoid any preflight inference request.
- Store benchmark outputs as files (`result.json` first; CSV/MD exports deferred to Spec 3); no DB requirement.
- Product docs (`agent-os/product/`) are baseline guidance and can evolve as implementation decisions mature.
- Visual context: none provided; no internal reference implementation exists yet in this repo.
- Expose a documented OpenAPI 3.1 surface so future clients and SDKs can integrate without reverse-engineering routes.
- If a dev-only runtime switch becomes necessary in this phase, introduce and document `CHIMERA_BENCH_DEV` here (with an actual usage site), rather than defining it early as an unused env var.

## Deliverables

- Bun/TypeScript server package following OpenCode-style architecture.
- Headless serve command with explicit network options (`--port`, `--hostname`, repeatable `--cors`, `--mdns`, `--mdns-domain`).
- Basic auth support for server mode (env vars per `server/api-conventions`) and explicit startup warnings when auth is unset.
- Safety guardrails for LAN: refuse non-loopback binds when auth is unset; require an explicit model-root allowlist when exposed.
- Hono API endpoints for health, engine discovery, run creation, run status, cancellation, run event streaming, and global event streaming.
- Engine plugin contract and registry/loader.
- `llama.cpp` plugin that starts and stops `llama-server` for a benchmark run.
- Plugin-owned validation for engine-specific inputs:
  - Verify `llama-server` is installed and runnable.
  - Validate `engine.serverArgs` against the installed binary's supported flags (default: strict; opt-in permissive mode).
  - Validate `engine.requestParams` for `/v1/chat/completions` (default: strict; opt-in permissive mode).
  - Reject/override reserved launch args that core/plugin owns (model path, host/port binding, web UI, API key).
  - Denylist flags/values that can write arbitrary files or expand network exposure.
- Single-run execution path (no sweep yet) using a small built-in starter workload.
- Run artifact persistence (`runs/{runId}/result.json`) using `runs/result-schema` (JSON required fields; CSV/MD exports deferred).
- OpenAPI 3.1 docs at `/doc` and generated SDK scaffolding for client use.

## Standards applied

- `agent-os/standards/server/api-conventions.md`
- `agent-os/standards/plugins/engine-interface.md`
- `agent-os/standards/runs/result-schema.md`

## Reference implementations

- See `references.md`.

## Related specs and execution sequence

1. `server-plugin-llama-cpp-foundation` (this spec)
2. `ssh-remote-execution-profiles`
3. `workload-packs-and-exports`
4. `sweep-engine-run-orchestration`
5. `log-metrics-efficiency-analysis`
6. `server-auth-and-ssh-secret-hardening`
7. `frontend-stack-decision-vue-vs-solid`
8. `client-dashboard-dual-run-mode`
9. `engine-expansion-vllm-exo`
10. `engine-enhancements-llama-cpp-tools` (`llama-cli`, `llama-bench`, HF model acquisition, host/port overrides)

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
- Generating `cases.csv` and `summary.md` artifacts in Spec 1 (deferred to Spec 3).

## Implementation tasks

1. Define serve command behavior and network flags from `server/api-conventions`:
   - Implement `chimera-bench serve` with defaults: `--hostname 127.0.0.1`, `--port 4096`.
   - Implement HTTP basic auth via environment variables:
     - `CHIMERA_SERVER_PASSWORD` enables auth.
     - `CHIMERA_SERVER_USERNAME` is optional; default username is `chimera`.
   - Startup warnings/guardrails:
     - If `CHIMERA_SERVER_PASSWORD` is unset: print an explicit startup warning.
     - If `--hostname` is non-loopback and password is unset: refuse to start with an actionable error.
     - If `--hostname` is non-loopback: require `CHIMERA_MODEL_ROOTS` to be set (colon-separated directories) to confine model paths.
    - CORS policy:
      - No CORS headers by default.
      - Each `--cors <origin>` adds that origin to an explicit allowlist (repeatable).
      - Handle preflight for requests that include `Authorization`.
    - mDNS:
      - When `--mdns` is enabled, advertise the server as `_chimera-bench._tcp`.
      - Default `--mdns-domain` to `chimera.local`.
    - Implement graceful shutdown (SIGINT/SIGTERM): stop accepting new runs, cancel an active run, cleanup engine subprocesses, close SSE streams.
    - Manual testing steps:
      - Start loopback server (expect a no-auth warning): `chimera-bench serve`
      - Verify health: `curl -sS http://127.0.0.1:4096/global/health`
      - Verify non-loopback requires auth (expect failure): `chimera-bench serve --hostname 0.0.0.0`
      - Start LAN server with auth + model roots:
        - `export CHIMERA_SERVER_PASSWORD=devpass`
        - `export CHIMERA_MODEL_ROOTS=/absolute/path/to/models`
        - `chimera-bench serve --hostname 0.0.0.0 --port 4096`
      - Verify auth required: `curl -i http://127.0.0.1:4096/global/health` (expect `401`)
      - Verify auth works: `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/global/health`
      - Verify CORS allowlist:
        - Start server with `--cors http://localhost:5173`
        - `curl -i -u chimera:$CHIMERA_SERVER_PASSWORD -H 'Origin: http://localhost:5173' http://127.0.0.1:4096/global/health`
        - Preflight: `curl -i -X OPTIONS -H 'Origin: http://localhost:5173' -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: Authorization' http://127.0.0.1:4096/global/health`
      - Verify mDNS (optional):
        - Linux: `avahi-browse -rt _chimera-bench._tcp`
        - macOS: `dns-sd -B _chimera-bench._tcp`

2. Define API routes and envelopes (Hono + zod), including `/global/health`, `/event`, `/doc`, and run/engine domains:
     - Response envelope is always `{ success, data|error, meta }` (per `server/api-conventions`).
     - Implementation layout:
       - `src/server/app.ts` is the composition root.
       - Route registration lives in `src/server/routes/`.
       - Request parsing/validation helpers live in `src/server/http/`.
       - SSE response helpers live in `src/server/sse/`.
       - In-memory run state/capacity policy lives in `src/server/runs/`.
     - Initial route table:
      - `GET /global/health` -> `{ success: true, data: { healthy: true, version: string }, meta: { requestId: string } }`
      - `GET /doc` -> OpenAPI 3.1 docs
      - `GET /event` -> global SSE (`server.connected`, `server.heartbeat`)
      - `GET /engines` -> engine capabilities + environment validation summary
      - `POST /runs` -> create run, return `runId` immediately
     - `GET /runs/:runId` -> run status + summary
     - `GET /runs/:runId/result` -> retrieve `result.json`
      - `POST /runs/:runId/cancel` -> cancel an active run
      - `GET /runs/:runId/event` -> run SSE
    - Define request/response schemas for all routes (zod) and generate OpenAPI from those schemas.
    - Define `POST /runs` request schema (initial):
      - `engineId` (string, required; example: `llama-cpp`)
      - `target` (object, required; Spec 1 supports `{ "type": "local" }` only)
      - `model.identifier` (string, required; local `.gguf` path for local runs)
      - `workloadId` (string, optional; default to the built-in starter workload)
      - `engine.serverArgs` (string[], optional; default `[]`)
      - `engine.requestParams` (object, optional; default `{}`)
      - `validationMode` (`strict` | `permissive`, optional; default `strict`)
      - `timeouts.caseMs` / `timeouts.runMs` (numbers, optional; defaults documented in Task 8)
    - Apply auth middleware when enabled (including SSE and `/doc`).
    - Define stable error codes for expected failures (`VALIDATION_*`, `ENGINE_*`, `RUN_*`, `INTERNAL_ERROR`).
    - Manual testing steps:
      - `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/global/health`
      - `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/engines`
      - Open docs: `http://127.0.0.1:4096/doc`
      - Verify global SSE connects: `curl -N -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/event`
      - After Task 8 is implemented, create a run:
        - `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD -H 'Content-Type: application/json' http://127.0.0.1:4096/runs -d '{"engineId":"llama-cpp","target":{"type":"local"},"model":{"identifier":"/absolute/path/to/models/model.gguf"},"engine":{"serverArgs":[],"requestParams":{}},"validationMode":"strict"}'`

3. Define plugin lifecycle contract from `plugins/engine-interface`, including plugin-owned validation responsibilities (environment, server args, request params) and a strict/permissive validation mode in run config:
   - Implement the interface types and ensure core only depends on the contract (no engine-specific branching).
   - Manual testing steps:
     - `bun run typecheck` (or equivalent) to ensure all built-in plugins satisfy the interface.

4. Implement plugin registry and engine capability listing, including an environment validation summary per engine:
   - Load built-in plugins (starting with `llama-cpp`).
   - Call `validateEnvironment()` to produce a summarized status object for `GET /engines`.
   - Cache environment validation results with a short TTL to keep `GET /engines` fast.
   - Manual testing steps:
     - `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/engines`
     - Verify the response includes `llama-cpp` and a non-crashing environment validation summary.

5. Implement `llama.cpp` (`llama-server`) plugin process lifecycle:
   - Execute subprocesses without a shell (argv array only).
   - Start `llama-server` in its own process group/session so stop/cancel can reliably terminate the entire group.
   - Choose a free local port; retry on bind/start failures to reduce TOCTOU issues.
   - Force bind to `127.0.0.1` (no user override in Spec 1).
   - Force-disable Web UI (`--no-webui`).
   - Generate a per-run `llama-server` API key:
     - Cryptographically random, >= 32 bytes entropy, hex or base64url.
     - Never written to run artifacts; never logged (redact if present in errors).
   - Pass model path from core-owned `model.identifier`.
   - Capture stdout/stderr with bounded buffers; include a bounded excerpt in diagnostics on failure.
   - Stop behavior: send a graceful termination signal first, then escalate to a hard kill after a short timeout to avoid orphaned processes.
   - Manual testing steps (after Task 8 exists):
     - Start a run (see Task 8 curl example).
     - While the run is `running`, verify `llama-server` is only bound to loopback:
       - Linux: `ss -ltnp | rg llama-server`
       - macOS: `lsof -iTCP -sTCP:LISTEN | rg llama-server`
     - Cancel the run and verify the `llama-server` process exits.

6. Implement `llama.cpp` plugin readiness checks using `GET /health` (no inference preflight):
    - Poll at a fixed interval (e.g. 200ms) with a max readiness timeout (e.g. 30s).
    - Treat connection refused/timeouts as not-ready; treat non-2xx responses as failures with diagnostics.
    - On readiness failure, stop the subprocess and surface a stable `ENGINE_START_FAILED` error.
   - Manual testing steps (after Task 8 exists):
     - Start a run and verify it transitions to `running` only after readiness succeeds.
     - Intentionally break `llama-server` (e.g., remove it from `PATH`) and verify the run fails fast with a stable `ENGINE_*` error.

7. Implement engine parameter validation (default: strict; explicit opt-in permissive mode):
    - Validate `model.identifier`:
      - Must be a readable local `.gguf` file path.
      - Canonicalize (absolute + realpath) before use.
      - If `CHIMERA_MODEL_ROOTS` is set: enforce an allowlist of model roots (colon-separated directories) and reject symlinks that escape allowlisted roots.
      - When the server binds to non-loopback, require `CHIMERA_MODEL_ROOTS` to be set.
   - Validate/normalize `engine.serverArgs`:
     - Parse `llama-server --help` to discover supported flags.
     - Strict: reject unknown flags; permissive: allow unknown flags.
     - Always reject any attempt to set reserved/core-owned flags (model/host/port/api-key/webui).
     - Maintain a denylist for flags/values that can write to arbitrary paths or expand network exposure.
     - If help parsing fails in strict mode: fail validation with an actionable error (permissive mode is the escape hatch).
    - Validate `engine.requestParams`:
      - Strict: validate a stable subset of `/v1/chat/completions` params (types and basic ranges) and reject unknown keys.
      - Always reject reserved keys owned by the orchestrator (at minimum: `messages`, `model`, `stream`).
      - Permissive: accept unknown keys but still reject reserved keys and obviously invalid types.
   - Manual testing steps (after Task 8 exists):
     - Invalid model path: set `model.identifier` to a missing file and expect a 4xx `VALIDATION_*` error.
     - Model root confinement (non-loopback): set `CHIMERA_MODEL_ROOTS` and try a path outside it; expect a 4xx `VALIDATION_*` error.
     - Unknown server flag (strict): `engine.serverArgs: ["--not-a-real-flag"]` with `validationMode: "strict"` -> expect 4xx.
     - Unknown server flag (permissive): same args with `validationMode: "permissive"` -> should start (or at least not fail validation).
     - Reserved server flag: `engine.serverArgs: ["--port","1234"]` -> expect 4xx even in permissive mode.
     - Unknown request param (strict): `engine.requestParams: {"made_up":123}` with strict -> expect 4xx.
     - Unknown request param (permissive): same param with permissive -> should be accepted.

8. Implement single benchmark run orchestration, event streaming, and cancellation:
   - Concurrency: allow a single active run at a time; `POST /runs` returns `409` with code `RUN_CONCURRENCY_LIMIT` if another run is active.
   - Workload source for Spec 1: embed a tiny built-in starter workload (3-10 prompts) with stable `workloadId` and `promptId`s; treat as a placeholder until Spec 3.
   - State machine: `queued` -> `running` -> terminal (`completed` | `failed` | `cancelled`).
    - Case execution:
      - Build chat messages (core-owned) and merge validated `engine.requestParams`.
      - Enforce a per-case timeout and an overall run timeout; record timeout failures per case.
      - Defaults (if not provided in `POST /runs`): `timeouts.caseMs = 120000`, `timeouts.runMs = 1800000`.
   - Partial failures:
     - Record per-case errors and continue when possible.
     - If the engine subprocess dies or readiness regresses, fail the run and mark remaining cases as failed.
   - Run SSE events (`GET /runs/:runId/event`):
     - `run.created`, `run.started`, `run.case.started`, `run.case.completed`, `run.case.failed`, `run.completed`, `run.failed`, `run.cancelled`.
     - Payloads include `runId`, and for case events: `caseId`, `index`, and progress counts.
    - Cancellation:
      - `POST /runs/:runId/cancel` is idempotent; if active, stop the engine subprocess and transition run to `cancelled`.
      - Emit `run.cancelled` and persist final `result.json`.
   - Manual testing steps:
     - Start a run:
       - `export MODEL_GGUF=/absolute/path/to/models/model.gguf`
       - `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD -H 'Content-Type: application/json' http://127.0.0.1:4096/runs -d '{"engineId":"llama-cpp","target":{"type":"local"},"model":{"identifier":"'$MODEL_GGUF'"},"engine":{"serverArgs":[],"requestParams":{}},"validationMode":"strict"}'`
     - Connect to run SSE (replace `RUN_ID`): `curl -N -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/runs/RUN_ID/event`
     - Verify `GET /runs/RUN_ID` shows progress and terminal status.
     - Test cancellation: `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD -X POST http://127.0.0.1:4096/runs/RUN_ID/cancel`
     - Test concurrency limit: create a second run while one is `running` and expect `409 RUN_CONCURRENCY_LIMIT`.

9. Persist run artifacts and expose read APIs; TTFT is best-effort and may be nullable until Spec 4:
   - Persist `runs/{runId}/result.json` using required fields from `runs/result-schema`.
   - Explicitly defer `cases.csv` and `summary.md` to Spec 3.
    - Write files atomically (temp + rename) and surface actionable disk errors.
   - Manual testing steps (after a run completes):
     - Verify file exists: `ls runs/RUN_ID/result.json`
     - Fetch via API: `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/runs/RUN_ID/result`

10. Generate and validate OpenAPI/SDK artifacts:
    - Generate OpenAPI 3.1 from route schemas and serve docs at `/doc`.
    - Add a CI check that fails on OpenAPI drift (generated OpenAPI and SDK scaffolding remain in sync with the server).
    - Provide developer commands/scripts for generation and drift checking (names can vary, but must be documented).
    - Manual testing steps:
      - Verify docs render: open `http://127.0.0.1:4096/doc`
      - Run generators: `bun run openapi:generate` and `bun run sdk:generate`
      - Run drift check: `bun run openapi:check`

11. Add tests, observability, and operator docs:
    - Unit tests: validation, run state machine, envelope/error mapping, model-root checks.
    - Integration tests: auth middleware behavior, CORS allowlist, zod validation, SSE handshake + heartbeat, engine registry output.
    - Optional E2E test (gated): run against a real `llama-server` + tiny GGUF model.
    - Observability: generate `requestId`, log with `requestId`/`runId`, redact secrets, include bounded engine log excerpts on failures.
    - Operator docs: installing/verifying `llama-server`, running on LAN safely (auth + CORS + model roots), common failure modes.
    - Manual testing steps:
      - Run unit/integration tests: `bun test`
      - Verify logs include `requestId` and `runId` and do not include secrets (API keys/passwords).
      - (Optional, gated) Run E2E: `CHIMERA_E2E=1 bun test`

12. If dev-only behavior gating is added, define and document `CHIMERA_BENCH_DEV` (behavior, defaults, and contributor setup updates).
    - Manual testing steps (only if used):
      - Run with dev mode off: `chimera-bench serve` and verify the gated behavior is disabled.
      - Run with dev mode on: `CHIMERA_BENCH_DEV=1 chimera-bench serve` and verify the gated behavior is enabled.

## Parallelizable task groups (low conflict)

- CLI + serve flags + auth/CORS middleware (Task 1) can proceed in parallel with API route schema definitions (Task 2) and plugin interface/types (Task 3).
- Plugin registry + engine listing (Task 4) can proceed once Task 3 types exist, in parallel with OpenAPI generation setup (Task 10) once Task 2 schemas exist.
- `llama-server` validation logic (Task 7) can be implemented in parallel with the subprocess lifecycle work (Task 5/6), since it is mostly pure parsing/validation.
- Orchestration + persistence (Tasks 8/9) are intentionally sequenced and will touch shared run-state and schema code.

## Exit criteria

- A user can start the server (loopback or LAN; LAN requires basic auth), submit a local `llama-server` chat-only run with validated parameters, observe SSE progress, cancel a run, and retrieve `result.json`.
