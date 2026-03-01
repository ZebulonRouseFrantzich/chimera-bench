# References for SSH Remote Execution Profiles

## Inspiration and similar implementations

- OpenCode architecture: https://github.com/anomalyco/opencode
- OpenCode server docs: https://opencode.ai/docs/server/

## SSH operational references

- OpenSSH `ssh(1)` manual: https://man.openbsd.org/ssh
- OpenSSH `ssh_config(5)` client config (ProxyJump, IdentityFile, etc.): https://man.openbsd.org/ssh_config
- OpenSSH `ssh-agent(1)` usage: https://man.openbsd.org/ssh-agent
- OpenSSH port forwarding guide (high-level): https://www.ssh.com/academy/ssh/tunneling-example

## Shell quoting references

- Python `shlex.quote` reference algorithm (good mental model for POSIX single-quote escaping): https://docs.python.org/3/library/shlex.html#shlex.quote
- POSIX shell command language overview: https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html

Key options this spec relies on:

- `StrictHostKeyChecking=yes`
- `BatchMode=yes`
- `ForwardAgent=no`
- `ExitOnForwardFailure=yes`
- `ServerAliveInterval` / `ServerAliveCountMax`

## Internal repo references

- Applied standards (embedded for offline review): `agent-os/specs/2026-02-23-1720-ssh-remote-execution-profiles/standards.md`
- Engine plugin interface: `agent-os/standards/plugins/engine-interface.md`
- Run result schema: `agent-os/standards/runs/result-schema.md`
- API conventions: `agent-os/standards/server/api-conventions.md`

Implementation touchpoints (expected):

- Run creation schema and normalization: `src/server/api/schemas.ts`
- Run routing and validation surface: `src/server/routes/run-routes.ts`
- Engine plugin interface types: `src/server/engines/engine-plugin.ts`
- llama.cpp plugin baseline behavior (local): `src/server/engines/starter-engine.ts`
