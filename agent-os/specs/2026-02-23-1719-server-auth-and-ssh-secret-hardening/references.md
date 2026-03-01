# References for Server Auth and SSH Secret Hardening

## Inspiration and similar implementations

- OpenCode server auth warning behavior: https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/cli/cmd/serve.ts
- OpenCode server middleware patterns: https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/server/server.ts

## Security references

- OWASP Authentication Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- OpenSSH `ssh(1)` manual: https://man.openbsd.org/ssh

## Internal repo references

- Applied standards (embedded for offline review): `agent-os/specs/2026-02-23-1719-server-auth-and-ssh-secret-hardening/standards.md`
- API conventions auth section: `agent-os/standards/server/api-conventions.md`
