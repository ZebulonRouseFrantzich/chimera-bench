# Spec 6 - Server Auth and SSH Secret Hardening

## Objective

Harden security for remote and internet-facing usage before broader distribution.

## Why this spec exists

The project explicitly supports SSH execution on local networks or over the internet. That requires explicit auth and secret-handling rules beyond core benchmark functionality.

## Context carried from shaping

- The architecture intentionally supports server/client separation and remote operation.
- Remote capability is a core product requirement, so security cannot be a deferred afterthought.
- Product is initially power-user focused, but defaults should still prevent unsafe deployments.

## Deliverables

- Server authentication model aligned to headless usage (HTTP basic auth with env-driven credentials).
- Secret storage strategy for SSH credentials and sensitive config.
- SSH key handling rules (key paths, passphrase handling, agent usage).
- Security defaults for remote execution (timeouts, host verification, command constraints).
- Threat model and operational checklist for self-hosted use.
- Startup safety behavior: warn when auth is unset and default to loopback-safe binding.

## Standards applied

- `agent-os/standards/server/api-conventions.md`

## Reference implementations

- OpenCode server docs: `https://opencode.ai/docs/server/`
- OpenCode server auth warning behavior in serve mode: `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/cli/cmd/serve.ts`
- OpenCode server middleware patterns: `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/server/server.ts`

## Non-goals

- Enterprise IAM/SSO.
- Managed cloud key vault integrations in first pass.

## Implementation tasks

1. Define minimum auth requirements for headless server mode (`CHIMERA_SERVER_PASSWORD`, optional `CHIMERA_SERVER_USERNAME`).
2. Define startup behavior for insecure mode (explicit warning and loopback-safe defaults).
3. Define secure local storage and redaction for sensitive fields.
4. Add host key verification and strict SSH defaults.
5. Add audit logging and failure alerts for remote execution actions.
6. Document secure deployment patterns for LAN and internet exposure.

## Exit criteria

- Remote benchmarking can be enabled without unsafe default credentials or plaintext secret leakage.

## Dependencies

- Should land before or alongside `ssh-remote-execution-profiles`.
