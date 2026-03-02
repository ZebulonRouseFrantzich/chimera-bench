# SSH Gated Integration Tests

Use opt-in gating for live SSH integration tests.

- Gate live SSH tests behind `CHIMERA_SSH_TEST=1`.
- When gate is off, register tests as `skip` (do not silently `return`).
- Read connection inputs from env (`HOST`, `PORT`, `USERNAME`, optional key-path).
- Bound all network waits with explicit timeouts.
- Always cleanup in `finally`:
  - abort active forwards/processes
  - await shutdown and tolerate expected cancellation errors
- Ensure helper Promises always settle on socket close/error to avoid hangs.

Operator-doc requirement for gated SSH tests:

- Provide a local harness path (for example Docker `sshd`).
- Require host-key fingerprint verification before appending scanned keys to `~/.ssh/known_hosts`.
