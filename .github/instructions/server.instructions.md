---
applyTo: "src/server/**/*.ts,tests/app-*.test.ts"
---

Use these standards for server-related review comments:

- `/agent-os/standards/server/api-conventions.md`
- `/agent-os/standards/server/json-request-validation.md`
- `/agent-os/standards/server/basic-auth.md`
- `/agent-os/standards/server/cors-allowlist.md`
- `/agent-os/standards/server/log-line-format.md`
- `/agent-os/standards/server/sse-streams.md`
- `/agent-os/standards/server/openapi-and-sdk-artifacts.md`
- `/agent-os/standards/global/sanitization-and-safe-errors.md`

When reviewing server changes, focus on:

- API envelope shape and `meta.requestId` consistency.
- Stable, explicit error codes and safe error payloads.
- Request validation completeness (zod checks, body limits, parameter validation).
- Auth/CORS safety defaults and conservative exposure behavior.
- Sanitization before logging or returning untrusted input.
- Required contract sync for API shape changes (`openapi/openapi.json` and `sdk/generated/*`).

Expect behavior-focused tests for route, middleware, and error-path changes.
