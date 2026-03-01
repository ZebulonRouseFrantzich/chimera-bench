# Run Events

Run lifecycle emits ordered, best-effort events.

Event names (stable):

- `run.created`
- `run.started`
- `run.case.started`
- `run.case.completed`
- `run.case.failed`
- `run.completed`
- `run.failed`
- `run.cancelled`

Payload rules:

- Payload is a JSON object.
- Payload always includes `runId`.
- Listener failures must not interrupt run state transitions.

Replay policy:

- Keep a bounded per-run event buffer (ring) for SSE reconnect catch-up.
- Replay returns only the last N events; older events are dropped.
- Clients must not assume the stream is fully reliable.
