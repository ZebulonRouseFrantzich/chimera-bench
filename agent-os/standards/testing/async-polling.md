# Async Polling in Tests

For async state transitions (runs, SSE readiness, etc.), prefer bounded polling helpers.

Rules:

- Poll in a loop with a short sleep between attempts.
- Bound attempts (or total time) to avoid hanging tests.
- Treat transient non-200 responses as retryable when appropriate.
- On timeout, throw an actionable error including the condition and identifiers (example: `runId`).
