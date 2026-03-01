# SSH Remote Execution Profiles - Shaping Notes

## Scope

- Add SSH target profiles (file-based persistence) and APIs to manage them.
- Extend run config to support `target.type = "ssh"`.
- Execute the existing `llama-cpp` engine on a remote host by:
  - starting remote `llama-server` bound to remote loopback
  - accessing it via an SSH local port-forward
  - persisting run artifacts on the orchestrator

## Decisions

- Use the system `ssh` binary (argv-only spawn) instead of embedding an SSH library initially.
- Default to strict host key checking.
- Prefer `ssh-agent` auth; allow referencing `privateKeyPath` but never store key contents or passphrases.
- Constrain remote model paths via an allowlist of remote model roots in the target profile.
- Avoid opening remote network ports; use port-forwarding to remote loopback.
- Visuals: none.

## Assumptions

- Remote hosts already have `llama-server` installed and accessible.
- Operators can provision SSH access and known-hosts entries.
- Remote model files exist on the remote host (no model upload in this spec).

## Risks

- Remote execution expands attack surface; mitigate via server auth, strict SSH defaults, and path allowlists.
- Orphaned remote processes on network interruption; mitigate via best-effort cleanup and clear diagnostics.

## Success Criteria

- A remote run can be started, monitored, cancelled, and produces a local `result.json`.
