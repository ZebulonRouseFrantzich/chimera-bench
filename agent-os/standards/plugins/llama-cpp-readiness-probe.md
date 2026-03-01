# llama.cpp Readiness Probe

Readiness is polled separately from process startup.

Endpoint:

- Probe `GET http://{host}:{port}/health` (derived from launch args).
- Send `Authorization: Bearer <apiKey>`.

Retry behavior:

- Retry on:
  - `HTTP 503`
  - transient fetch/network errors (connection refused, timeouts, DNS/transient host errors)
- Fail immediately if the process terminates before readiness.

Timeouts:

- Each probe request has a bounded timeout (AbortController).
- The overall readiness wait has a bounded timeout.

Failure reporting:

- On failure, surface `ENGINE_START_FAILED` with safe reason.
- Include a bounded response excerpt for non-503 HTTP failures when available.
