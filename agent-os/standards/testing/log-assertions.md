# Log Assertions

Prefer token-based assertions over log snapshots.

Rules:

- Inject a capture logger into `createApp()` in tests.
- Store emitted lines in an array.
- Assert only on stable tokens (examples):
  - `requestId=...`
  - `runId=...`
  - `event=...`
  - `status=...`
- Avoid asserting full log lines or exact ordering unless required.
