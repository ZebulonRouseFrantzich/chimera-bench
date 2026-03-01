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
