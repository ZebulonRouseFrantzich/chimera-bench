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
- Case events include case identity fields (`caseId`, `promptId`, `index`).
- Case events include progress counters: `totalCases`, `completedCases`, `failedCases`.
- Terminal run events include progress counters.
- Keep event payloads small: do **not** include per-case `engineArgs`, `requestParams`, or full model output/raw response blobs.
- Listener failures must not interrupt run state transitions.

Replay policy:

- Keep a bounded per-run event buffer (ring) for SSE reconnect catch-up.
- Replay returns only the last N events; older events are dropped.
- Clients must not assume the stream is fully reliable.
