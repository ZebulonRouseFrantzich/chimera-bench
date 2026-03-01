# OpenAPI and SDK Artifacts

Generated + committed artifacts:

- `openapi/openapi.json`
- `sdk/generated/client.ts`
- `sdk/generated/index.ts`

Rules:

- Do not hand-edit generated artifacts.
- When changing API routes/schemas/OpenAPI wiring, regenerate:
  - `bun run openapi:generate`
  - `bun run sdk:generate`
- CI enforces drift-free artifacts via `bun run openapi:check`.

Source of truth:

- `src/server/api/schemas.ts`
- `src/server/api/openapi.ts`
- `scripts/openapi-artifacts.ts`

SDK operation IDs:

- Derived from method + path (example: `GET /runs/{runId}/event` -> `getRunsByRunIdEvent`).
- Treat path/method changes as breaking for SDK consumers.
