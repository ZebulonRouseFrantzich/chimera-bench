# Server Log Line Format

Server logs use a consistent, grep-friendly format.

Rules:

- Prefix every log line with `[chimera-bench]`.
- Use space-separated `key=value` tokens for context.
- Include stable identifiers when available:
  - `requestId=...` for HTTP work
  - `runId=...` for run/orchestration work
  - `pluginId=...` for engine/plugin work
- Sanitize untrusted strings before logging (remove control characters).
- Bound untrusted payload size (truncate long messages / JSON `data=` blobs).
- Redact secrets (passwords, API keys) from args and log excerpts.

Avoid:

- Multi-line log entries.
- Logging raw subprocess output without sanitization + bounding.
