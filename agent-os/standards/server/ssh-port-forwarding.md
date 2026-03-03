# SSH Port Forwarding

Use loopback-only SSH forwarding with fail-fast startup.

- Forward only `127.0.0.1:<localPort> -> 127.0.0.1:<remotePort>`.
- Always set `-o ExitOnForwardFailure=yes` and `-N`.
- Startup must be bounded:
  - probe local forwarded port readiness
  - fail on timeout, cancellation, or early ssh termination
  - surface remote loopback connect failures as actionable errors
- Retry local-port startup only when local port is auto-assigned.
  - If caller pinned `localPort`, do not retry with a different port.
- Tie forward lifecycle to abort/shutdown; cancel local `ssh` promptly.
- Return bounded stdout/stderr excerpts for diagnostics.

This standard exists for both security (no remote exposure) and reliability (deterministic startup/failure behavior).
