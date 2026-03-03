# Server Auth and SSH Secret Hardening

## Objective

Harden security for remote and internet-facing usage before broader distribution.

## Why this spec exists

The project explicitly supports SSH execution on local networks or over the internet. That requires explicit auth and secret-handling rules beyond core benchmark functionality.

## Context carried from shaping

- The architecture intentionally supports server/client separation and remote operation.
- Remote capability is a core product requirement, so security cannot be a deferred afterthought.
- Product is initially power-user focused, but defaults should still prevent unsafe deployments.

## Deliverables

- Server auth hardening beyond `server-plugin-llama-cpp-foundation`:
  - Support password-from-file (`CHIMERA_SERVER_PASSWORD_FILE`) in addition to `CHIMERA_SERVER_PASSWORD`.
  - Enforce minimum password length and emit explicit warnings for unsafe configurations.
  - Add basic brute-force mitigation (rate-limit repeated auth failures).
- Secret handling rules:
  - Redact secrets from logs and error responses.
  - Ensure run artifacts never persist secrets (API keys, auth headers, private key contents).
- SSH hardening:
  - Strict host key checking by default.
  - Clear SSH key handling guidance (prefer `ssh-agent`; allow key-path references only).
  - Command execution constraints and timeouts for remote actions.
- Audit logging for security-relevant actions.
- Threat model and operational checklist for self-hosted LAN/internet use.

## Standards applied

- `agent-os/standards/server/api-conventions.md`
- `agent-os/standards/plugins/engine-interface.md`
- `agent-os/standards/runs/result-schema.md`

## Reference implementations

- See `references.md`.

## Non-goals

- Enterprise IAM/SSO.
- Managed cloud key vault integrations in first pass.

## Implementation tasks

1. Define minimum auth requirements for headless server mode.
   - Supported inputs:
     - `CHIMERA_SERVER_PASSWORD` (direct)
     - `CHIMERA_SERVER_PASSWORD_FILE` (read password from a file; trims trailing newline)
     - `CHIMERA_SERVER_USERNAME` (optional; default `chimera`)
   - Password policy:
     - Enforce a minimum length (document the threshold).
     - Reject empty/whitespace-only passwords.
   - Manual testing steps:
     - Start server with env password and verify 401/200 behavior:
       - `export CHIMERA_SERVER_PASSWORD=devpass`
       - `chimera-bench serve --hostname 0.0.0.0`
       - `curl -i http://127.0.0.1:4096/global/health` (expect 401)
       - `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/global/health`
     - Start server with password file:
       - `printf '%s\n' devpass > /tmp/chimera-pass`
       - `export CHIMERA_SERVER_PASSWORD_FILE=/tmp/chimera-pass`

2. Define startup behavior for insecure mode.
    - Maintain `server-plugin-llama-cpp-foundation` guardrails:
     - Warn when auth is unset.
     - Refuse non-loopback binding when auth is unset.
   - Add tightening:
     - Refuse startup if password is below minimum length.
     - Emit explicit warnings when binding to non-loopback (LAN/WAN exposure).
   - Manual testing steps:
     - Attempt to start with a short password and verify the server refuses to start.

3. Define secure local storage and redaction for sensitive fields.
   - Redaction policy:
     - Never log: `Authorization` header, basic auth password, per-run engine API keys.
     - Never persist: per-run engine API keys, auth headers, private key contents.
   - Ensure any persisted configs (targets, runs) contain references/paths only.
   - Add tests that assert redaction on common failure paths.
   - Manual testing steps:
     - Run a local and SSH benchmark and then verify secrets are absent:
       - `rg -n "Authorization|CHIMERA_SERVER_PASSWORD|api[-_ ]?key" runs/ ~/.chimera-bench/` (expect no matches)

4. Add host key verification and strict SSH defaults.
   - Enforce:
     - `StrictHostKeyChecking=yes`
     - `BatchMode=yes`
     - `ForwardAgent=no`
     - sane timeouts and keepalive
   - Provide an operator override for known-hosts file path (path only; default to OpenSSH behavior).
   - Manual testing steps:
     - Connect to an unknown host and verify the run fails without prompting.
     - Confirm agent forwarding is disabled.

5. Add audit logging and failure alerts for remote execution actions.
   - Write an audit log as JSONL under `~/.chimera-bench/audit.log`.
   - Log (at minimum): server start/stop, auth enabled/disabled, target create/update, run create/cancel, remote command start/stop (redacted).
   - Manual testing steps:
     - Perform actions (create target, start run, cancel run) and verify entries appear in `~/.chimera-bench/audit.log`.

6. Document secure deployment patterns for LAN and internet exposure.
   - Add an operator-facing doc:
     - LAN-safe defaults
     - required auth
     - model/workload root confinement
     - SSH key + host key recommendations
   - Manual testing steps:
     - Follow the doc on a clean machine/shell and confirm the steps work.

## Exit criteria

- Remote benchmarking can be enabled without unsafe default credentials or plaintext secret leakage.

## Dependencies

- Builds on `server-plugin-llama-cpp-foundation` and `ssh-remote-execution-profiles`.
- Should land before recommending internet exposure or storing any additional secrets at rest.
