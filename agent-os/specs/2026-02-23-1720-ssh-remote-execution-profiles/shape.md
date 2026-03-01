# SSH Remote Execution Profiles - Shaping Notes

## Why this exists

The project supports a "dedicated LLM machine" model: run `llama-server` on a machine with the right GPU/CPU/RAM and consume it remotely from tools like OpenCode.

chimera-bench needs to benchmark and tune `llama-server` launch settings for that hardware by iterating through many configurations and selecting the ones that are both stable (no OOM crashes) and performant (low TTFT, high tokens/sec).

## Scope

- Deployment model focus: "remote engine controlled over SSH" (orchestrator runs chimera-bench; LLM machine runs `llama-server`).
- Add SSH target profiles (file-based persistence) and APIs to manage them.
- Extend run config to support `target.type = "ssh"`.
- Execute the existing `llama-cpp` engine on a remote host by:
  - starting a remote `llama-server` bound to remote loopback only
  - accessing it via an SSH local port-forward
  - persisting run artifacts on the orchestrator host

Note: the repo also supports a co-located mode (run chimera-bench on the LLM machine and connect to it remotely). That mode is recommended when you want "engine-only" numbers without network/tunnel overhead. This spec does not implement that mode; it documents it.

## Decisions

- Use the system `ssh` binary (spawn argv-only locally) instead of embedding an SSH library initially.
- Default to strict host key checking.
- Prefer `ssh-agent` auth; allow referencing `privateKeyPath` but never store key contents or passphrases.
- Disable SSH agent forwarding by default (`ForwardAgent=no`).
- Avoid opening remote network ports. Remote `llama-server` binds to `127.0.0.1` and the orchestrator connects via SSH local port-forward.
- Port forwarding is loopback-only in this phase (no non-loopback remote forwarding).
- Constrain remote model paths via an allowlist of remote model roots in the target profile.
- Persist target profiles under `~/.chimera-bench/targets/` with restrictive permissions (POSIX `0700` dir / `0600` files) and a `schemaVersion` for future migration.
- Treat remote command construction as a security boundary:
  - remote commands are executed by the remote user's shell
  - build commands from argv arrays and convert to command strings via strict POSIX shell quoting
- Prefer a single SSH session per run that both establishes the port-forward and runs the remote `llama-server` in the foreground (`exec`) to minimize orphan risk.
- Provide first-class local CLI commands (`chimera-bench targets list/show/rm/check/forward`) so operators can validate SSH connectivity and forwarding without writing scripts.
- `chimera-bench targets exec` exists for debugging but is explicitly gated behind an opt-in environment variable to reduce accidental remote-shell capability on shared orchestrators.
- Visuals: none.

## Assumptions

- Remote hosts already have `llama-server` installed and accessible (no install/build automation here).
- Operators can provision SSH access and known-hosts entries.
- Remote model files exist on the remote host (no model upload/sync in this spec).
- The orchestrator and LLM machine can establish SSH port-forwarding (no firewall policy blocking it).
- The SSH user's login shell is POSIX-compatible (for example `bash`/`dash`), since OpenSSH executes remote commands via the login shell.
- Remote host is in the same trust domain / effectively single-user:
  - Per-run API keys passed on the remote `llama-server` command line may be visible via `ps` to other remote users.

## Risks

- Remote execution expands attack surface.
  - Mitigate with server auth, strict SSH defaults, remote model allowlists, and robust remote command quoting.
- `targets exec` is effectively arbitrary remote command execution.
  - Mitigate with explicit enablement gating and clear operator documentation.
- Orphaned remote processes on network interruption.
  - Mitigate by coupling tunnel + remote server to a single SSH session per run, plus best-effort cleanup.
- Benchmark fidelity differences.
  - Remote mode intentionally measures "client-observed" performance (includes network/tunnel overhead).
  - For engine/hardware-only measurement, use the co-located deployment model.

## Success Criteria

- A remote run can be started, monitored, and cancelled.
- The orchestrator persists a local `result.json` with correct status and safe diagnostics.
- Remote `llama-server` is not exposed on the network (loopback-only).
