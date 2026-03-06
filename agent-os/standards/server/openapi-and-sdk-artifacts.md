# OpenAPI and SDK Artifacts

Generated + committed artifacts:

- `openapi/openapi.json`
- `sdk/generated/client.ts`
- `sdk/generated/index.ts`

Rules:

- Do not hand-edit generated artifacts.
- `openapi.info.version` and `sdk/generated/client.ts` `API_VERSION` are sourced
  from `SERVER_API_VERSION` in `src/server/version-metadata.ts`.
- `SERVER_API_VERSION` follows semver and should only be bumped when API
  contract changes (routes/schemas/behavior that affects API consumers).
- Application release version bumps alone must not force OpenAPI/SDK version
  churn.
- When changing API routes/schemas/OpenAPI wiring, regenerate:
  - `bun run openapi:generate`
  - `bun run sdk:generate`
- CI enforces drift-free artifacts via `bun run openapi:check`.

Source of truth:

- `src/server/api/schemas.ts`
- `src/server/api/openapi/index.ts`
- `src/server/version-metadata.ts`
- `scripts/openapi-artifacts.ts`

SDK operation IDs:

- Derived from method + path (example: `GET /runs/{runId}/event` -> `getRunsByRunIdEvent`).
- Treat path/method changes as breaking for SDK consumers.
