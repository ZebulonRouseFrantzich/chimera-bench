# Copilot PR Review Instructions

When reviewing pull requests in this repository:

- Treat these files as the source of truth for conventions:
  - `/agent-os/standards/index.yml`
  - `/AGENTS.md`
- Prioritize findings in this order: security, correctness, reliability, performance, maintainability.
- De-prioritize style-only comments unless they hide a functional risk or violate a documented standard.
- For each finding, include severity (`Critical`, `High`, `Medium`, `Low`), file path, impact, and a concrete fix recommendation.
- Prefer evidence from this repository and cite relevant standards file paths when possible.

Project context:

- Runtime and language: Bun + strict TypeScript.
- HTTP framework: Hono.
- Tests: `bun test`.

Review expectations:

- Preserve API and server conventions in `/agent-os/standards/server/`.
- Never suggest changes that expose secrets in logs, errors, fixtures, test snapshots, or generated artifacts.
- If API schemas or route contracts change, verify OpenAPI and SDK artifacts are updated together:
  - `openapi/openapi.json`
  - `sdk/generated/client.ts`
  - `sdk/generated/index.ts`

CI parity checks for this repo:

- `bun run lint`
- `bun run openapi:check`
- `bun test`
