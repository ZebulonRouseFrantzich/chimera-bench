---
applyTo: "src/server/api/**/*.ts,src/server/routes/**/*.ts,openapi/**/*.json,sdk/generated/**/*.ts,scripts/generate-openapi.ts,scripts/generate-sdk.ts,scripts/check-openapi-drift.ts"
---

Use this standard for OpenAPI and SDK contract review:

- `/agent-os/standards/server/openapi-and-sdk-artifacts.md`

When reviewing API-contract-related changes, focus on:

- Route/schema changes are reflected in OpenAPI and generated SDK artifacts.
- Generated files are treated as generated outputs, not hand-edited business logic.
- Drift checks remain authoritative (`bun run openapi:check`).
- Error response and envelope schemas stay aligned with runtime route behavior.

If a PR changes server contracts but omits artifact updates, raise a high-confidence issue.
