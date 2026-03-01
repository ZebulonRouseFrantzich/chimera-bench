# Basic Auth

Basic auth is optional and is enforced by middleware.

Enablement:

- If auth is disabled or password is unset, middleware must pass through.

Preflight:

- `OPTIONS` bypasses auth so CORS preflight succeeds.

Challenges + errors:

- Missing/invalid credentials:
  - set `WWW-Authenticate` (realm)
  - return `401` `AUTH_REQUIRED`
- Too many failures:
  - return `429` `AUTH_RATE_LIMITED`
  - set `Retry-After` and `WWW-Authenticate`

Rate limiting:

- Use an in-process, bounded auth-failure limiter.
- When `trustProxy` is off, do not trust forwarded IP headers; bucket failures under a single "direct-client" key.
- When `trustProxy` is on, derive client key from `X-Forwarded-For` (first value) or `X-Real-IP`.

Comparisons:

- Compare username/password using timing-safe equality.
