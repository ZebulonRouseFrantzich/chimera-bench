# SSH Command Execution

Use system `ssh` with strict, non-interactive defaults for security and deterministic ops.

- Spawn `ssh` with argv only (`shell: false`); do not invoke a local shell.
- Build remote command from argv via POSIX single-quote escaping; reject NUL bytes.
- Always include:
  - `-o BatchMode=yes`
  - `-o StrictHostKeyChecking=yes`
  - `-o ForwardAgent=no`
  - `-o ConnectTimeout=10`
  - `-o ServerAliveInterval=10`
  - `-o ServerAliveCountMax=3`
- Stream stdout/stderr into bounded rolling buffers; expose bounded excerpts in failures.
- Support cancellation + overall timeout by terminating local `ssh` promptly.
- Redact sensitive values in argv and surfaced error text.
- Include actionable guidance for common failures (host-key mismatch, permission denied, empty ssh-agent).

No exceptions to these defaults.
