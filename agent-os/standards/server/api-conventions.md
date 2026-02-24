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

## Auth and exposure defaults

- Support HTTP basic auth for server mode via environment variables.
- Use `CHIMERA_SERVER_PASSWORD` for the password.
- Use `CHIMERA_SERVER_USERNAME` optionally; default username is `chimera`.
- If auth is unset, print an explicit startup warning.
- Treat non-loopback hosts without auth as unsupported for production usage.

## OpenAPI and SDK

- Publish OpenAPI 3.1 docs at `/doc`.
- Keep the generated SDK contract in sync with route schemas.
- Treat OpenAPI as a first-class interface for future clients.

## Baseline operational endpoints

- `GET /global/health` returns `{ healthy: true, version: string }`.
- `GET /event` provides SSE with an initial `server.connected` event and heartbeat events.
- `GET /global/event` may be added for cross-project/global event streams when needed.
- Use typed event payloads so clients can consume streams safely.

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
- `meta` is optional; use it for IDs, pagination, and timing.

## Error handling

- Map expected failures to 4xx with stable codes (`VALIDATION_*`, `ENGINE_*`, `RUN_*`, `REMOTE_*`).
- Return `500` with `INTERNAL_ERROR` for unexpected failures.
- Log full diagnostics server-side; return safe messages to API clients.

## Long-running benchmarks

- Create and return a `runId` immediately for async run workflows.
- Stream progress with typed events (SSE or WebSocket) for client updates.
- Terminal run states are `completed`, `failed`, or `cancelled`.
