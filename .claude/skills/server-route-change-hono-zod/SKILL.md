---
name: server-route-change-hono-zod
description: Implement or update Hono server routes with zod schemas, envelope conventions, OpenAPI consistency, and tests.
argument-hint: "[route group or endpoint change]"
disable-model-invocation: true
---

Use this workflow for server API route changes.

## Standards to read first

- `agent-os/standards/server/api-conventions.md`
- `agent-os/standards/global/sanitization-and-safe-errors.md`
- `agent-os/standards/global/time-based-testing.md` (when TTL/timeout logic changes)

## Procedure

1. Scope the change:
   - Identify route group(s): `global`, `engines`, or `runs`.
   - Identify request/response shape changes and expected error codes.
2. Update schemas first:
   - Add/update zod schemas in `src/server/api/schemas.ts`.
   - Keep envelope and route schema types aligned.
3. Update route handlers:
   - Edit domain route files in `src/server/routes/`.
   - Preserve envelope shape `{ success, data|error, meta }` and request-id behavior.
4. Keep docs/contracts in sync:
   - Update OpenAPI wiring if needed in `src/server/api/openapi.ts`.
   - Ensure `/doc` behavior remains consistent with conventions.
5. Apply safety conventions:
   - Use stable error codes for expected failures.
   - Sanitize untrusted strings before logging/exposing values.
6. Add/update tests:
   - Route behavior tests in `tests/app-*.test.ts`.
   - Add deterministic tests for TTL/time-based behavior.
7. Verification gate:
   - Run `bun run lint`.
   - Run targeted tests for changed areas.
   - Run full `bun test`.
8. Report:
   - Summarize what changed, why, and verification results.

## Guardrails

- Keep diffs minimal and avoid unrelated refactors.
- Do not add route-level behavior that conflicts with standards without updating standards explicitly.
