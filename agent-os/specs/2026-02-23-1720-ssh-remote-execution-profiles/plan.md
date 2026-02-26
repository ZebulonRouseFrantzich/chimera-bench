# Spec 2 - SSH Remote Execution Profiles

## Objective

Run benchmarks on remote machines over SSH while storing run definitions and artifacts on the orchestrator host.

## Context carried from shaping

- Remote execution must support both local-network and internet-reachable hosts; defaults must be safe.
- Run details and benchmark artifacts are anchored on the orchestrator side.
- Remote support preserves the same plugin contract and result schema used for local runs.
- Prefer approaches that avoid opening remote ports; use SSH port-forwarding to a remote loopback-only `llama-server` in this phase.
- Avoid storing secret material at rest in early phases: do not store private key contents; prefer `ssh-agent`.

## Deliverables

- SSH target profile model and persistence (file-based):
  - `id`, `displayName`, `host`, `port`, `username`.
  - Auth method: `ssh-agent` (default) or `privateKeyPath` reference (no key contents).
  - Known-hosts policy: strict host key checking by default.
  - Remote model roots allowlist (used to validate remote `model.identifier` paths).
  - Optional remote runtime hints (e.g., explicit `llamaServerPath`).
- SSH execution adapter (argv-only, no shell):
  - Run remote commands with streamed stdout/stderr, timeouts, and cancellation.
  - Redact sensitive values from logs.
- SSH port-forward helper:
  - Create a local ephemeral port that forwards to a remote `127.0.0.1:<port>`.
  - Use `ExitOnForwardFailure`-style behavior to fail fast when forwarding cannot be established.
- Extend run config to support SSH targets:
  - `target: { "type": "ssh", "profileId": "..." }` (extends Spec 1's `{ "type": "local" }`).
  - For SSH targets, interpret `model.identifier` as a remote absolute GGUF path validated against the profile's allowlisted remote roots.
- Remote mode for the existing `llama-cpp` plugin:
  - Start `llama-server` on the remote host bound to `127.0.0.1` with Web UI disabled and a per-run API key.
  - Connect to it via SSH local port-forward and reuse the same HTTP orchestration path.
  - Stop and cleanup on cancellation and server shutdown.
- Operator docs for configuring and running SSH targets safely.

## Standards applied

- `agent-os/standards/server/api-conventions.md`
- `agent-os/standards/plugins/engine-interface.md`
- `agent-os/standards/runs/result-schema.md`

## Reference implementations

- OpenCode server docs: `https://opencode.ai/docs/server/`
- OpenCode split server/client deployment model: `https://github.com/anomalyco/opencode`

## Non-goals

- Fleet scheduling across many remote hosts.
- Cloud provider provisioning automation.
- Uploading/syncing model files from orchestrator to remote hosts.
- Password-based SSH auth (prefer `ssh-agent` / key files).

## Implementation tasks

1. Define SSH target profile schema and file-based persistence.
   - Profile fields (initial):
     - `id` (stable string, required)
     - `displayName` (string, required)
     - `host` (string, required)
     - `port` (number, optional; default `22`)
     - `username` (string, required)
     - `auth` (object, required):
       - `{ "method": "ssh-agent" }` (default)
       - or `{ "method": "key-path", "privateKeyPath": "/abs/path" }` (no key contents)
     - `remoteModelRoots` (string[], required when `target.type = ssh` is used)
     - `llamaServerPath` (string, optional; default `llama-server`)
   - Persistence:
     - Store profiles on the orchestrator host as files under `~/.chimera-bench/targets/` (one file per `id`).
     - Never store private key contents, passphrases, or SSH agent sockets.
   - Validate all fields with zod and surface `VALIDATION_*` errors.
   - Manual testing steps:
     - Create a profile via API (Task 2) and verify a file is written under `~/.chimera-bench/targets/`.

2. Add target management APIs (route group: `/targets`).
   - Route table:
     - `GET /targets` -> list profiles (no secrets)
     - `POST /targets` -> create/update profile
     - `GET /targets/:id` -> fetch profile
   - Apply server auth middleware (basic auth) and the standard response envelope.
   - Manual testing steps:
     - Create/update a profile:
       - `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD -H 'Content-Type: application/json' http://127.0.0.1:4096/targets -d '{"id":"lab","displayName":"Lab box","host":"10.0.0.10","port":22,"username":"ubuntu","auth":{"method":"ssh-agent"},"remoteModelRoots":["/models"],"llamaServerPath":"llama-server"}'`
     - List: `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/targets`
     - Get: `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/targets/lab`

3. Implement SSH command execution utility.
   - Use the system `ssh` binary (argv-only spawn; no shell).
   - Default options (baseline):
     - `-o BatchMode=yes`
     - `-o StrictHostKeyChecking=yes`
     - `-o ConnectTimeout=10`
     - `-o ServerAliveInterval=10` and `-o ServerAliveCountMax=3`
   - Support key-path auth by adding `-i <privateKeyPath>` (path-only, never persisted).
   - Stream stdout/stderr for diagnostics; keep bounded buffers for inclusion in error responses.
   - Cancellation must terminate the local `ssh` process and mark the run as `cancelled`.
   - Manual testing steps:
     - Verify a simple remote command:
       - `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes ubuntu@10.0.0.10 'echo ok'`
     - Verify host key behavior: connect to an unknown host and confirm it fails without prompting.

4. Implement SSH port-forward utility.
   - Establish a local forward to remote loopback:
     - `ssh -N -L 127.0.0.1:<localPort>:127.0.0.1:<remotePort> ...`
   - Fail fast when forwarding cannot be established (use `ExitOnForwardFailure`-style behavior).
   - Tie the forward lifecycle to the run: cancellation and shutdown must tear down the forward.
   - Manual testing steps:
     - Manually create a forward:
       - `ssh -N -L 127.0.0.1:18080:127.0.0.1:8080 ubuntu@10.0.0.10`
     - In another shell: `curl -sS http://127.0.0.1:18080/health`

5. Integrate SSH targets into run config and validation.
   - Extend `POST /runs` schema:
     - `target: { "type": "ssh", "profileId": "lab" }`
   - Validation rules for SSH runs:
     - `model.identifier` is a remote absolute `.gguf` path.
     - It must be under one of the profile's `remoteModelRoots` (path-prefix check on a canonicalized path).
     - Persist `target: "ssh"` and `targetProfileId` (non-secret) metadata in `result.json`.
   - Manual testing steps:
     - Create a run with `target.type=ssh` and a remote model path under an allowlisted root.
     - Try a remote model path outside `remoteModelRoots` and expect a 4xx `VALIDATION_*` error.

6. Add remote start/stop support for the existing `llama-cpp` plugin.
   - Start remote `llama-server`:
     - Bind to remote loopback only (`127.0.0.1`).
     - Disable Web UI (`--no-webui`).
     - Generate a per-run API key (never logged/persisted).
     - Choose a remote port (retry on failure); record the chosen port and remote PID in run context.
   - Connect via port-forward:
     - Start the SSH port-forward and use local HTTP to perform readiness checks and execute cases.
   - Stop/cleanup:
     - On completion/cancel/failure, terminate remote `llama-server` (best-effort) and tear down forwarding.
     - Never leave a remote `llama-server` running if the orchestrator is still alive.
   - Manual testing steps:
     - Start a remote run and verify the orchestrator can reach the forwarded `/health`.
     - Cancel the run and verify:
       - port-forward process exits
       - remote `llama-server` process is terminated (best-effort)

7. Add integration tests and operator docs.
   - Tests:
     - Unit tests for profile validation and remote path allowlist checks.
     - Integration tests (gated) using a controlled SSH target.
   - Docs:
     - How to create SSH target profiles.
     - Host key setup and strict checking.
     - Remote model roots and where models should live on the remote host.
   - Manual testing steps:
     - Run unit/integration tests: `bun test`
     - (Optional, gated) Run SSH integration tests: `CHIMERA_SSH_TEST=1 bun test`

## Exit criteria

- A user can execute a benchmark run remotely over SSH and retrieve a local `result.json` with correct status.

## Dependencies

- Requires `server-plugin-llama-cpp-foundation`.
