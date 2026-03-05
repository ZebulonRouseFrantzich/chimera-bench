# Standards for Sweep MVP

This spec embeds core standards for offline review and references additional standards that apply to Sweep MVP.

## Additional standards (references only)

High relevance:

- `agent-os/standards/runs/run-events.md`
- `agent-os/standards/runs/orchestrator-cancellation-timeouts.md`
- `agent-os/standards/runs/artifact-store.md`
- `agent-os/standards/runs/sweep-config-validation.md`
- `agent-os/standards/runs/sweep-expansion-and-case-ids.md`
- `agent-os/standards/runs/sweep-execution-orchestration.md`
- `agent-os/standards/runs/sweep-result-and-ranking.md`
- `agent-os/standards/plugins/llama-cpp-mixed-gpu-guard.md`
- `agent-os/standards/plugins/llama-cpp-remote-help-discovery-cache.md`
- `agent-os/standards/plugins/llama-cpp-case-execution.md`
- `agent-os/standards/plugins/llama-cpp-ssh-remote-cleanup.md`
- `agent-os/standards/server/json-request-validation.md`
- `agent-os/standards/server/request-param-budgets.md`
- `agent-os/standards/server/sse-streams.md`
- `agent-os/standards/global/sanitization-and-safe-errors.md`
- `agent-os/standards/server/openapi-and-sdk-artifacts.md`

Optional:

- `agent-os/standards/runs/built-in-workload-hardening.md`
- `agent-os/standards/global/ttl-cache-and-inflight-dedupe.md`
- `agent-os/standards/server/log-line-format.md`
- `agent-os/standards/server/ssh-command-execution.md`

---

## Server API Conventions (`agent-os/standards/server/api-conventions.md`)

# Server API Conventions

Use Bun + Hono with zod validation for all public server routes.

## Serve command and network surface

- Provide a headless server command: `chimera-bench serve [--port <number>] [--hostname <string>] [--cors <origin>] [--mdns] [--mdns-domain <name>]`.
- Default to `127.0.0.1` on port `4096` for local-safe startup.
- Default mDNS domain to `chimera.local` when mDNS is enabled.
- Allow `--cors` multiple times to support multiple browser clients.
- Keep loopback as the default; any LAN/WAN exposure requires explicit hostname selection.

## Route shape

- Group routes by domain (`/global`, `/runs`, `/engines`, `/workloads`, `/exports`).
- If versioning is added, apply it consistently across all route groups.
- Validate `params`, `query`, and `json` payloads with zod before route handlers.
- Generate OpenAPI from route schemas so docs and validation stay in sync.

## Server code layout

- Keep `src/server/app.ts` as a composition root (middleware + error handling + route registration).
- Register domain routes in `src/server/routes/`:
  - `global-routes.ts` (`/global/*`, `/doc`, `/event`)
  - `engine-routes.ts` (`/engines`)
  - `run-routes.ts` (`/runs/*`)
- Keep shared HTTP parsing/validation helpers in `src/server/http/`.
- Keep SSE stream helpers in `src/server/sse/`.
- Keep run state/storage/capacity policy in `src/server/runs/`.
- Keep engine metadata helpers in `src/server/engines/`.
- Keep middleware in `src/server/middleware/`.

## Auth and exposure defaults

- Support HTTP basic auth for server mode via environment variables.
- Use `CHIMERA_SERVER_PASSWORD` for the password.
- Use `CHIMERA_SERVER_USERNAME` optionally; default username is `chimera`.
- If auth is unset, print an explicit startup warning.
- Treat non-loopback hosts without auth as unsupported for production usage.
- Do not trust `X-Forwarded-For` / `X-Real-IP` by default.
- Only honor forwarding headers when `CHIMERA_SERVER_TRUST_PROXY=1` and the server is behind a trusted reverse proxy that sanitizes those headers.

## OpenAPI and SDK

- Publish OpenAPI 3.1 docs at `/doc`.
- Keep the generated SDK contract in sync with route schemas.
- Treat OpenAPI as a first-class interface for future clients.

## Baseline operational endpoints

- All API responses include an `X-Request-Id` response header.
- JSON API responses always include `meta.requestId` and it matches `X-Request-Id`.

- `GET /global/health` returns `{ success: true, data: { healthy: true, version: string }, meta: { requestId: string } }`.
- `GET /event` provides SSE with an initial `server.connected` event and heartbeat events.
- `GET /global/event` may be added for cross-project/global event streams when needed.
- Use typed event payloads so clients can consume streams safely.

## Engine discovery resilience

- `GET /engines` should remain available even when a single engine validation fails.
- Engine environment validation should use a bounded timeout to avoid hanging requests.
- Cache environment validation summaries with a short TTL to reduce repeated expensive checks.
- Deduplicate in-flight environment validations per engine so concurrent requests do not perform duplicate work.
- Prefer shorter cache TTLs for error summaries than success summaries to reduce stale transient failures.
- Return safe client-facing environment failure summaries; keep detailed diagnostics in server logs.

## Response envelope

Success responses:

```json
{ "success": true, "data": { "id": "run_123" }, "meta": { "requestId": "req_456" } }
```

Error responses:

```json
{
  "success": false,
  "error": {
    "code": "ENGINE_START_FAILED",
    "message": "Unable to start llama-server",
    "details": { "exitCode": 1 }
  },
  "meta": { "requestId": "req_456" }
}
```

- Never mix `data` and `error` in the same response.
- `meta.requestId` is required for JSON API responses.
- `/doc` is an exception: it returns raw OpenAPI JSON (not enveloped).

## Error handling

- Map expected failures to 4xx with stable codes (`VALIDATION_*`, `ENGINE_*`, `RUN_*`, `REMOTE_*`).
- Return `500` with `INTERNAL_ERROR` for unexpected failures.
- Log full diagnostics server-side; return safe messages to API clients.

## Defensive request limits

- For JSON body endpoints (for example `POST /runs`):
  - Require `Content-Type: application/json` (reject others with `415`).
  - Apply a conservative request body size limit (reject oversized payloads with `413`).

## Long-running benchmarks

- Create and return a `runId` immediately for async run workflows.
- Stream progress with typed events (SSE or WebSocket) for client updates.
- Terminal run states are `completed`, `failed`, or `cancelled`.
- Enforce run capacity limits atomically at creation time (avoid check-then-act across `await` boundaries).

---

## Engine Plugin Interface (`agent-os/standards/plugins/engine-interface.md`)

# Engine Plugin Interface

All inference backends (`llama.cpp`, `vLLM`, `exo`, etc.) implement `EnginePlugin`.
Core must not branch on engine-specific behavior.

## Registration requirements

- `apiVersion` must equal `ENGINE_PLUGIN_API_VERSION`.
- `id` must be unique and match `^[a-z0-9]+(?:-[a-z0-9]+)*$` (example: `llama-cpp`).

## Required plugin metadata

- `displayName`: human-friendly name.
- `version`: plugin version.
- `capabilities`: supported features.

## Required lifecycle (in order)

1. `validateEnvironment()`
2. `validateRunConfig(runConfig)`
3. `buildLaunchConfig(runConfig)`
4. `start(context)`
5. `waitUntilReady(context)`
6. `executeCase(context, caseConfig)`
7. `collectMetrics(context)`
8. `stop(context)`

## Run config validation

- Plugin owns validation + normalization of:
  - `model.identifier`
  - `engine.serverArgs` (launch flags)
  - `engine.requestParams` (request payload params)
- `validationMode`:
  - `strict` (default): reject unknown flags/params.
  - `permissive`: allow unknown flags/params for experimentation.
- Reserved/denylisted flags/params are rejected in all modes.
- Prefer capability checks over version caps.

## Config boundaries

- Core owns generic benchmark config; plugin owns mapping to launches/requests.
- Preserve raw pass-through so new engine flags do not require core changes:
  - `engine.serverArgs: string[]`
  - `engine.requestParams: Record<string, unknown>`

## Launch safety

- Plugins must not install, download, build, or upgrade engine software.
- `EngineLaunchConfig.environmentOverrides` must not include unsafe injection keys (`LD_PRELOAD`, `LD_AUDIT`, `NODE_OPTIONS`, `DYLD_*`). No bypass.

## Errors + diagnostics

- For expected failures, throw an error with `code` + safe `message` (+ optional `details`).
- Use `ENGINE_*` codes for fatal engine failures.
- Treat subprocess output as untrusted; sanitize + bound excerpts; redact secrets (for example API keys) from args and logs.

---

## Run Result Schema (`agent-os/standards/runs/result-schema.md`)

# Run Result Schema

Persist benchmark data as JSON first, then derive CSV and markdown exports from JSON.

## Required top-level run fields

- `schemaVersion`
- `runId`
- `createdAt`
- `orchestratorVersion`
- `engineId`
- `engineVersion`
- `target` (`local` or `ssh`)
- `model` (object with at least `identifier`)
- `workloadId`
- `status`
- `startedAt`
- `finishedAt`
- `durationMs`

## Conditional top-level fields

- `targetProfileId`
  - required when `target` is `ssh`
  - omitted (or `null`) when `target` is `local`
  - additive field; no schema version bump required for this addition

## Required per-case fields

- `caseId`
- `runId`
- `index`
- `promptId`
- `contextTokens`
- `engineArgs`
- `requestParams`
- `status`
- `latencyMs`
- `ttftMs` (nullable; best-effort until deep log parsing is implemented)
- `outputTokens`
- `tokensPerSecond`
- `promptEvalTokensPerSecond` (nullable)
- `acceptanceRatio` (nullable)
- `error` (nullable)

## Units and naming

- Durations use milliseconds (`*Ms`).
- Throughput uses tokens per second.
- Ratios are decimal values in range `[0, 1]`.
- JSON keys use `camelCase`; CSV headers use `snake_case`.

## Extensibility

- Add optional metrics under `metricsExtra` (JSON object).
- Mirror that field in CSV as `metrics_extra_json`.
- Never remove required fields without bumping `schemaVersion`.

## Export artifacts

Each run must emit:

- `runs/{runId}/result.json`
- `runs/{runId}/cases.csv`
- `runs/{runId}/summary.md`
