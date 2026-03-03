# Server Auth and SSH Secret Hardening - Shaping Notes

## Scope

- Harden the headless server's auth and exposure behavior for LAN/internet use.
- Define and implement strict secret-handling rules across logs, artifacts, and config persistence.
- Harden SSH defaults used for remote execution.
- Add audit logging for security-relevant actions.

## Decisions

- Basic auth is the baseline (introduced in `server-plugin-llama-cpp-foundation`). This spec tightens it and adds safer operational options.
- Prefer env vars and file references over storing secrets in JSON config.
- Default to strict SSH host key checking.
- Visuals: none.

## Assumptions

- `server-plugin-llama-cpp-foundation` already enforces loopback defaults and requires auth for non-loopback binds.
- `ssh-remote-execution-profiles` introduces SSH target profiles without storing private key contents.

## Risks

- Accidental secret leakage via logs/artifacts is easy; mitigations must be enforced with tests.
- SSH command construction can become an injection surface; mitigate by avoiding untrusted interpolation and using strict defaults.

## Success Criteria

- A LAN/internet-exposed deployment has clear guardrails, no secret leakage, and an audit trail for remote actions.
