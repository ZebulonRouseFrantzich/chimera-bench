# Sanitization and Safe Errors

Use a consistent policy for strings that may come from untrusted inputs or external tools.

## String sanitization

- Sanitize control characters (`U+0000`-`U+001F`, `U+007F`) before writing values to logs or response payloads.
- Reuse shared sanitization helpers instead of re-implementing route-specific variants.
- Keep sanitization behavior consistent across server routes and middleware.

## API error exposure

- Public API responses should include safe, actionable messages and stable error codes.
- Do not return raw internal exception messages directly to API clients.
- Log detailed diagnostics server-side (including identifiers like `requestId` and `runId` when available).

## Logging safety

- Treat plugin and subprocess output as untrusted text.
- Redact secrets and credentials before logging.
- Keep raw diagnostic content bounded where possible to avoid log flooding.
