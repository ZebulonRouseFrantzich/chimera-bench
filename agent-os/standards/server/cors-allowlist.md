# CORS Allowlist

CORS is deny-by-default.

- Configure allowed origins via repeatable `--cors` (normalized to URL `.origin`).
- For non-allowlisted origins: do not set CORS headers (silent deny).

Preflight handling:

- Only handle preflight when `Origin` is allowlisted.
- Allow methods: `GET`, `POST`, `OPTIONS`.
  - Otherwise: `405` `CORS_METHOD_NOT_ALLOWED`.
- Allow request headers: `Authorization`, `Content-Type`, `Accept`.
  - Otherwise: `400` `CORS_HEADER_NOT_ALLOWED`.
- Preflight success response:
  - `204`
  - `Access-Control-Allow-Origin: <origin>`
  - `Access-Control-Allow-Credentials: true`
  - `Access-Control-Allow-Methods: <method>`
  - `Access-Control-Allow-Headers: <allowlisted headers>`
  - `Access-Control-Max-Age: 600`
  - `Vary` includes `Origin` and `Access-Control-Request-Headers`.

Actual requests:

- For allowlisted origins, set `Access-Control-Allow-Origin` + `Access-Control-Allow-Credentials` and `Vary: Origin`.

Middleware ordering:

- `OPTIONS` must bypass auth so browsers can preflight.
