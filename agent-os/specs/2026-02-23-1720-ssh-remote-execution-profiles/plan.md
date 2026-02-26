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
   - Validate all fields with zod.
   - Do not store private key contents or passphrases.

2. Add target management APIs (route group: `/targets`).
   - `GET /targets` lists available target profiles.
   - `POST /targets` creates/updates a profile.
   - `GET /targets/:id` returns a profile.

3. Implement SSH command execution utility.
   - Use the system `ssh` binary (argv-only spawn).
   - Default options: `BatchMode=yes`, `StrictHostKeyChecking=yes`, connect timeout, and keepalive.
   - Stream stdout/stderr for diagnostics; bound buffers for persisted excerpts.

4. Implement SSH port-forward utility.
   - Allocate a local free port.
   - Establish a forward to the remote loopback `127.0.0.1:<remotePort>`.
   - Fail fast when forwarding cannot be established.

5. Integrate SSH targets into run config and validation.
   - Extend `POST /runs` schema to allow `target.type = ssh`.
   - Validate remote `model.identifier` as an absolute `.gguf` path under the profile's allowlisted remote roots.
   - Persist `target: "ssh"` metadata in `result.json`.

6. Add remote start/stop support for the existing `llama-cpp` plugin.
   - Start remote `llama-server` bound to remote loopback with `--no-webui` and a per-run API key.
   - Use port-forwarded local HTTP to run readiness checks and execute cases.
   - Cancellation and shutdown must terminate the remote process (best-effort) and tear down port forwarding.

7. Add integration tests and docs.
   - Integration tests should run against a controlled SSH target (container or dedicated CI target) when available.
   - Document safe SSH setup (keys, host keys, model roots) and common failure modes.

## Exit criteria

- A user can execute a benchmark run remotely over SSH and retrieve a local `result.json` with correct status.

## Dependencies

- Requires `server-plugin-llama-cpp-foundation`.
