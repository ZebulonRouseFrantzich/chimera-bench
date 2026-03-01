# llama.cpp API Key and Redaction

API keys are per-run secrets.

Generation:

- Generate a fresh `llama-server` API key per run.
- Require >=32 bytes entropy (base64url) and enforce a minimum length.

Usage:

- Launch `llama-server` with `--api-key <key>`.
- Use `Authorization: Bearer <key>` for readiness/health requests.

Redaction:

- Treat API keys as secrets everywhere.
- Redact from:
  - launch args (`--api-key`, `--api_key`, and `--...=...` forms)
  - stdout/stderr excerpts
  - diagnostic reasons/errors
- Use a stable placeholder (example: `[REDACTED]`).

Cleanup:

- Clear in-memory `apiKey` and auth headers on stop.
