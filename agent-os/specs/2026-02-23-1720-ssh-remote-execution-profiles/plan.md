# SSH Remote Execution Profiles

## Objective

Run benchmarks against LLM engines on remote machines over SSH while storing orchestration state and artifacts on the orchestrator host.

This is a building block for sweep/auto-tuning workflows where chimera-bench iterates through many `llama-server` argument combinations to find stable (no OOM/crash) and high-performance settings for a specific model + LLM-server hardware.

## Deployment models (intent)

This project intentionally supports multiple deployment models. This spec focuses on model #2.

1. Co-located driver + engine (recommended when you want engine/hardware numbers)
   - Run `chimera-bench serve` on the LLM machine; it starts/stops `llama-server` locally.
   - From another machine (laptop), connect to the chimera-bench server via SSH port-forwarding.
   - Metrics are closest to "engine-only" behavior (minimal network/tunnel overhead).

2. Remote engine controlled over SSH (this spec; recommended when you want to emulate real remote usage)
   - Run `chimera-bench serve` on an orchestrator machine.
   - It starts/stops `llama-server` on a dedicated "LLM machine" over SSH and connects through an SSH local port-forward.
   - Metrics are "client-observed" and include network + SSH tunnel overhead. Comparisons are most meaningful when the orchestrator host and network path stay consistent across sweeps.

## Performance interpretation

- `ttftMs` is time-to-first-token; lower is better.
- `tokensPerSecond` is throughput; higher is better.
- SSH/port-forward mode adds overhead (latency + CPU). For sweeps, keep the orchestrator machine, route (LAN vs WAN), and tunnel settings stable so the overhead is relatively constant across configurations.

## Context carried from shaping

- Remote execution must support both local-network and internet-reachable hosts; defaults must be safe.
- Run definitions, status, and benchmark artifacts are anchored on the orchestrator host.
- Remote support preserves the same engine plugin contract and result schema used for local runs.
- Prefer approaches that avoid opening remote ports. Use SSH port-forwarding to a remote loopback-only `llama-server` in this phase.
- Avoid storing secret material at rest in early phases: do not store private key contents; prefer `ssh-agent`.
- SSH-based remote commands are executed via the remote user's shell; treat remote command construction as a security boundary and apply strict quoting and input validation.
- This phase inherits the current single-active-run constraint from `server-plugin-llama-cpp-foundation`, which simplifies SSH tunnel/process lifecycle management.

## Deliverables

- SSH target profile model and persistence (file-based, orchestrator-side):
  - Fields:
    - `schemaVersion` (number, required; initial value `1`)
    - `id`, `displayName`, `host`, `port`, `username`
    - `auth`: `ssh-agent` (default) or `key-path` with `privateKeyPath` reference (no key contents)
    - `remoteModelRoots`: allowlist of remote absolute paths used to validate remote `model.identifier`
    - `llamaServerPath`: optional; default `llama-server` (constrained; see Task 1)
  - Policy:
    - Strict host key checking by default.
    - Never store private key contents, passphrases, or SSH agent sockets.
    - Profiles are stored under `~/.chimera-bench/targets/` (one JSON file per `id`).
    - Storage permissions (POSIX):
      - `~/.chimera-bench/targets/` is `0700`
      - `~/.chimera-bench/targets/<id>.json` is `0600`
- Target management APIs (`/targets`) with zod validation + envelope responses:
  - `GET /targets`
  - `POST /targets`
  - `GET /targets/:id`
  - `DELETE /targets/:id`
- SSH execution utilities (spawn `ssh` argv-only locally):
  - Stream stdout/stderr with bounded buffers for diagnostics.
  - Timeouts and cancellation that terminate the local `ssh` process.
  - Secret redaction (at minimum: per-run API keys).
  - Safe SSH defaults: `BatchMode=yes`, `StrictHostKeyChecking=yes`, `ForwardAgent=no`, bounded connect/keepalive.
  - Remote command string is assembled via strict POSIX shell quoting (no unescaped interpolation).
  - Explicit remote shell requirement: the SSH user must have a POSIX-compatible shell.
- SSH port-forward helper:
  - Create a local ephemeral port forwarding to remote `127.0.0.1:<remotePort>`.
  - Fail fast (`ExitOnForwardFailure=yes`) when forwarding cannot be established.
  - Lifecycle tied to the run (cancel/shutdown tears down forwarding).
- Extend run config to support SSH targets:
  - `target: { "type": "ssh", "profileId": "..." }` (extends `server-plugin-llama-cpp-foundation`'s `{ "type": "local" }`).
  - For SSH targets, interpret `model.identifier` as a remote absolute `.gguf` path validated against the profile's `remoteModelRoots`.
- Remote mode for the existing `llama-cpp` plugin:
  - Validate engine flags against the remote `llama-server --help` output when `validationMode=strict`.
  - Start `llama-server` on the remote host bound to `127.0.0.1` with Web UI disabled and a per-run API key.
  - Connect via SSH local port-forward and reuse the same HTTP orchestration path.
  - Stop/cleanup on completion, cancellation, and server shutdown.
- Operator docs: safe configuration, known-hosts setup, and guidance on choosing deployment model #1 vs #2.
- Engine discovery exposes SSH capability:
  - `GET /engines` includes `capabilities.sshTarget`.
- First-class CLI commands for SSH target operation and smoke testing:
  - `chimera-bench targets list`: list profiles in `~/.chimera-bench/targets/`.
  - `chimera-bench targets show <profileId>`: print the stored profile JSON.
  - `chimera-bench targets rm <profileId>`: delete the stored profile file.
  - `chimera-bench targets check <profileId>`: verify the profile can connect and run a tiny remote command.
  - `chimera-bench targets forward <profileId> --remote-port <port>`: open a local port-forward to remote loopback.
  - `chimera-bench targets exec <profileId> [--dry-run] -- <argv...>`: run a specific remote command argv for debugging.
    - Security: gated behind an explicit operator opt-in (see Task 2).
    - Supports `--dry-run` to print the constructed `ssh` argv without executing.

## Standards applied

CLI:

- `agent-os/standards/cli/arg-parsing.md`
- `agent-os/standards/cli/exit-codes.md`
- `agent-os/standards/cli/signal-shutdown.md`

Global:

- `agent-os/standards/global/sanitization-and-safe-errors.md`
- `agent-os/standards/global/time-based-testing.md`

Server:

- `agent-os/standards/server/api-conventions.md`
- `agent-os/standards/server/basic-auth.md`
- `agent-os/standards/server/cors-allowlist.md`
- `agent-os/standards/server/graceful-shutdown.md`
- `agent-os/standards/server/json-request-validation.md`
- `agent-os/standards/server/log-line-format.md`
- `agent-os/standards/server/openapi-and-sdk-artifacts.md`
- `agent-os/standards/server/serve-exposure-safety.md`
- `agent-os/standards/server/sse-streams.md`

Plugins:

- `agent-os/standards/plugins/engine-interface.md`
- `agent-os/standards/plugins/llama-cpp-api-key-and-redaction.md`
- `agent-os/standards/plugins/llama-cpp-model-identifier-validation.md`
- `agent-os/standards/plugins/llama-cpp-readiness-probe.md`
- `agent-os/standards/plugins/llama-cpp-stop-escalation.md`
- `agent-os/standards/plugins/llama-cpp-strict-flag-validation.md`
- `agent-os/standards/plugins/llama-cpp-subprocess-startup.md`

Runs:

- `agent-os/standards/runs/artifact-store.md`
- `agent-os/standards/runs/orchestrator-cancellation-timeouts.md`
- `agent-os/standards/runs/result-schema.md`
- `agent-os/standards/runs/run-events.md`

Testing:

- `agent-os/standards/testing/app-fixtures.md`
- `agent-os/standards/testing/async-polling.md`
- `agent-os/standards/testing/log-assertions.md`

## Reference implementations

- OpenCode server docs: `https://opencode.ai/docs/server/`
- OpenCode split server/client deployment model: `https://github.com/anomalyco/opencode`

## Non-goals

- Fleet scheduling across many remote hosts.
- Cloud provider provisioning automation.
- Uploading/syncing model files from orchestrator to remote hosts.
- Password-based SSH auth (prefer `ssh-agent` / key files).
- A dedicated remote "runner/agent" process that executes the whole benchmark on the LLM machine (possible future direction).

## Implementation tasks

### Task 1 - SSH target profiles: schema, persistence, and APIs

Define an SSH target profile model, persist it on the orchestrator host, and expose CRUD-ish management endpoints.

Profile schema (initial):

- `schemaVersion` (number, required)
  - Must equal `1`.
- `id` (stable string, required)
  - Pattern: `^[a-z0-9]+(?:-[a-z0-9]+)*$` (same style as engine IDs).
- `displayName` (string, required)
- `host` (string, required)
  - Hostname or IP; do not allow whitespace.
- `port` (number, optional; default `22`; range `1..65535`)
- `username` (string, required)
- `auth` (object, required)
  - `{ "method": "ssh-agent" }` (default)
  - or `{ "method": "key-path", "privateKeyPath": "/abs/path" }`
    - Path must be absolute.
    - Persist the path only; never store key contents or passphrases.
    - Validate at create/update time that `privateKeyPath` exists and is readable by the orchestrator user.
- `remoteModelRoots` (string[], required)
  - Each entry must be an absolute path.
  - Used to validate SSH runs' remote `model.identifier`.
  - Must contain at least 1 root.
- `llamaServerPath` (string, optional; default `llama-server`)
  - Allowed values:
    - `llama-server` (uses PATH on the remote host)
    - or an absolute path that ends with `/llama-server`
  - For absolute paths, require a conservative character allowlist (ASCII only):
    - Must match `^/[A-Za-z0-9._/-]+/llama-server$`

Persistence:

- Store one profile per file under `~/.chimera-bench/targets/`.
  - Recommended filename: `~/.chimera-bench/targets/<id>.json`.
- Writes are atomic (temp file + rename).
- Storage permissions (POSIX):
  - Ensure `~/.chimera-bench/targets/` is `0700`.
  - Ensure `~/.chimera-bench/targets/<id>.json` is `0600`.
- Concurrency: last-write-wins if two updates race.

API route group: `/targets`

- `GET /targets` -> list profiles
- `POST /targets` -> create/update a profile by `id`
- `GET /targets/:id` -> fetch profile by id
- `DELETE /targets/:id` -> delete profile by id

HTTP status codes:

- `POST /targets`
  - `201` when a profile is created
  - `200` when an existing profile is updated
- `DELETE /targets/:id` returns `200` with a success envelope when deletion succeeds.

All `/targets` routes:

- Use zod validation and standard response envelope.
- Apply server auth middleware.
- Use stable error codes:
  - `VALIDATION_TARGET_PROFILE_INVALID`
  - `TARGET_PROFILE_NOT_FOUND`
  - `TARGET_PROFILE_PERSIST_FAILED`
  - `TARGET_PROFILE_DELETE_FAILED`

Example profile JSON:

```json
{
  "schemaVersion": 1,
  "id": "lab",
  "displayName": "Lab LLM box",
  "host": "10.0.0.10",
  "port": 22,
  "username": "ubuntu",
  "auth": { "method": "ssh-agent" },
  "remoteModelRoots": ["/models"],
  "llamaServerPath": "llama-server"
}
```

Manual Testing:

1. Start server with auth:
   - `export CHIMERA_SERVER_PASSWORD="$(openssl rand -base64 24)"`
   - `just serve` (recommended) or `chimera-bench serve`
2. Create/update a profile:
   - `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD -H 'Content-Type: application/json' http://127.0.0.1:4096/targets -d '{"schemaVersion":1,"id":"lab","displayName":"Lab LLM box","host":"10.0.0.10","port":22,"username":"ubuntu","auth":{"method":"ssh-agent"},"remoteModelRoots":["/models"],"llamaServerPath":"llama-server"}'`
3. Verify persistence:
   - `ls -la ~/.chimera-bench/targets/`
   - Confirm `lab.json` exists and contains the expected fields (no private key contents).
   - Verify permissions (Linux):
     - `stat -c '%a %n' ~/.chimera-bench/targets ~/.chimera-bench/targets/lab.json` (expect `700` and `600`)
4. Fetch and list:
   - `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/targets`
   - `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/targets/lab`
5. Validation failures:
   - Omit `remoteModelRoots` and confirm `400 VALIDATION_TARGET_PROFILE_INVALID`.
   - Set `port` to `99999` and confirm validation error.
   - Set `auth.method=key-path` with a nonexistent `privateKeyPath` and confirm validation error.
6. Not found:
   - `curl -i -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/targets/does-not-exist` (expect `404 TARGET_PROFILE_NOT_FOUND`).
7. Delete:
   - `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD -X DELETE http://127.0.0.1:4096/targets/lab`
   - Confirm `lab.json` is removed and `GET /targets/lab` returns `404`.

### Task 2 - SSH utilities: safe remote command execution

Implement a small SSH abstraction used by plugins and (optionally) by validation code.

Constraints and safety:

- Use the system `ssh` binary (spawn argv-only locally).
- Do not start a local shell to run `ssh`.
- Treat the remote command string as a security boundary:
  - Build remote commands from an argv array.
  - Convert argv -> remote command string using strict POSIX shell quoting.
  - Never concatenate unescaped user-controlled strings into the remote command.
  - Reject arguments containing `\0` (NUL).

Remote shell requirement:

- OpenSSH executes the remote command via the SSH user's login shell.
- For this phase, require that the SSH user's login shell is POSIX-compatible (for example `bash`/`dash`), not `fish`/`csh`.
- Operator docs must call this out explicitly.

Quoting algorithm (must be specified and tested):

- Implement a `quotePosixShellArg(arg: string): string` helper.
- Algorithm (equivalent to Python `shlex.quote`):
  - If `arg` is empty: return `''`.
  - Otherwise: wrap in single quotes and escape embedded single quotes by closing/opening:
    - `foo'bar` -> `'foo'\''bar'`
- Build the remote command string by quoting each argv element and joining with spaces.
- Add focused unit tests with adversarial strings (quotes, dollars, backticks, newlines, pipes, semicolons).

Default ssh options (baseline):

- `-o BatchMode=yes`
- `-o StrictHostKeyChecking=yes`
- `-o ForwardAgent=no`
- `-o ConnectTimeout=10`
- `-o ServerAliveInterval=10`
- `-o ServerAliveCountMax=3`

Auth handling:

- `ssh-agent` mode uses default OpenSSH behavior.
- `key-path` mode adds `-i <privateKeyPath>` (path reference only).

Process behavior:

- Stream stdout/stderr to diagnostics; keep bounded buffers for error excerpts.
- Implement timeouts (connect + overall command time).
- Cancellation must terminate the local `ssh` process promptly.
- Redact sensitive values in logs and in any surfaced error details.
- For common SSH failures, surface actionable messages (while still including bounded raw SSH stderr excerpts):
  - host key unknown/mismatch
  - permission denied / auth failure
  - ssh-agent has no identities loaded

Note: `ssh` itself is resolved via the current `PATH`. Operator docs should treat `$PATH` on the orchestrator as trusted.

CLI commands (first-class; implemented in this task):

CLI wiring requirements:

- Add a `targets` top-level command alongside `serve`.
- Update general help (`chimera-bench help`) to mention `targets`.
- Recommended code layout:
  - `src/cli/targets-command.ts` implements parsing + subcommand routing.
  - `src/cli.ts` routes `targets` to that module and maps errors to exit codes.

Maintainability requirement:

- Keep SSH utilities in a small module (for example `src/server/ssh/*`) with minimal dependencies so they can be unit-tested independently of the target profile store and the server.

- `chimera-bench targets list`
  - Lists profiles stored under `~/.chimera-bench/targets/`.
  - Does not require the server process to be running.

- `chimera-bench targets show <profileId>`
  - Prints the stored profile JSON.
  - Does not require the server process to be running.

- `chimera-bench targets rm <profileId>`
  - Deletes the stored profile file.
  - Does not require the server process to be running.

- `chimera-bench targets check <profileId>`
  - Reads the target profile from `~/.chimera-bench/targets/<id>.json`.
  - Runs a tiny remote command via the SSH exec helper (default: `echo ok`).
  - Prints a short human-friendly result and exits non-zero on failure.
  - Must not print secrets.

- `chimera-bench targets exec <profileId> [--dry-run] -- <argv...>`
  - Runs an explicit remote command argv via the SSH exec helper.
  - Streams remote stdout/stderr to local stdout/stderr.
  - Supports Ctrl+C cancellation (terminates local `ssh` promptly).
  - Must not print secrets (redaction applies to orchestrator-generated values like API keys).
  - Security gate:
    - The command must refuse to execute unless `CHIMERA_ENABLE_TARGETS_EXEC=1` is set.
    - `--dry-run` is always allowed and prints the constructed `ssh` argv (as a JSON array) without executing.
    - When execution is enabled, print a clear warning to stderr (once) that this subcommand runs arbitrary remote commands as the configured SSH user.

Exit codes (targets subcommands):

- `0`: success
- `1`: runtime failure (SSH connect/auth failure, remote command failure, IO)
- `2`: usage error (unknown subcommand, missing args, `targets exec` run without enablement)

Examples:

- `chimera-bench targets list`
- `chimera-bench targets show lab`
- `chimera-bench targets rm lab`
- `chimera-bench targets check lab`
- `CHIMERA_ENABLE_TARGETS_EXEC=1 chimera-bench targets exec lab -- echo ok`
- `CHIMERA_ENABLE_TARGETS_EXEC=1 chimera-bench targets exec lab -- sleep 60`
- `chimera-bench targets exec lab --dry-run -- echo ok`

Justfile command wrapper (implemented as part of this spec):

- `just targets -- <subcommand> ...` forwards to `chimera-bench targets ...`.

Manual Testing:

Prereq: pick a reachable SSH host and ensure it is present in `~/.ssh/known_hosts`.

If you're creating/updating profiles via the `/targets` API during these steps, keep `chimera-bench serve` running from Task 1.

1. Create a `lab` target profile (Task 1).
2. Verify local profile listing/show works without a running server:
   - Stop the server (Ctrl+C) if it's running.
   - `chimera-bench help` and confirm it lists the `targets` command.
   - `chimera-bench targets list`
   - `chimera-bench targets show lab`
3. Verify a simple remote command via the first-class CLI:
   - `chimera-bench targets check lab`
   - Or via just: `just targets -- check lab`
   - Confirm it exits `0` and prints a success message.
4. Verify the `targets exec` security gate:
   - Without enablement: `chimera-bench targets exec lab -- echo ok`
   - Confirm it fails with a usage error and mentions `CHIMERA_ENABLE_TARGETS_EXEC=1`.
5. Verify `--dry-run` is allowed without enablement:
   - `chimera-bench targets exec lab --dry-run -- echo ok`
   - Confirm it prints a JSON argv array that begins with `ssh`.
6. Verify running an explicit remote argv when enabled:
   - `CHIMERA_ENABLE_TARGETS_EXEC=1 chimera-bench targets exec lab -- echo ok`
   - Confirm stdout contains `ok` and exit code is `0`.
7. Verify cancellation tears down the local `ssh` process:
   - `CHIMERA_ENABLE_TARGETS_EXEC=1 chimera-bench targets exec lab -- sleep 60`
   - Press Ctrl+C after ~1s and confirm the command exits quickly.
8. Verify agent forwarding is disabled:
   - `CHIMERA_ENABLE_TARGETS_EXEC=1 chimera-bench targets exec lab -- printenv SSH_AUTH_SOCK`
   - Confirm it prints nothing (or exits non-zero), meaning no forwarded agent socket.
9. Verify strict host key behavior (unknown host fails without prompting):
   - Start the server again if you stopped it earlier (needed for `/targets`):
     - `export CHIMERA_SERVER_PASSWORD="$(openssl rand -base64 24)"` (or reuse the existing one)
     - `just serve`
   - Choose a *reachable* SSH host and temporarily remove its known-hosts entry:
     - `ssh-keygen -R 10.0.0.10`
   - Create a temporary target profile that points at that host:
     - `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD -H 'Content-Type: application/json' http://127.0.0.1:4096/targets -d '{"schemaVersion":1,"id":"hostkey-test","displayName":"Host key test","host":"10.0.0.10","port":22,"username":"ubuntu","auth":{"method":"ssh-agent"},"remoteModelRoots":["/models"],"llamaServerPath":"llama-server"}'`
   - Run: `chimera-bench targets check hostkey-test`
   - Confirm it fails with a known-hosts/host-key error and does not prompt.
   - Restore known-hosts entry (trusted networks only):
     - `ssh-keyscan -H 10.0.0.10 >> ~/.ssh/known_hosts`
10. Verify friendly diagnostics when ssh-agent has no identities (if applicable):
   - Temporarily run without your agent loaded (e.g., in a clean shell without `ssh-add`).
   - `chimera-bench targets check lab`
   - Confirm the error message suggests `ssh-add` / loading an identity.
11. Verify `targets rm`:
   - `chimera-bench targets rm hostkey-test`
   - Confirm it removes `~/.chimera-bench/targets/hostkey-test.json`.

### Task 3 - SSH utilities: port forwarding

Implement a helper that establishes an SSH local port-forward to a remote loopback port.

Requirements:

- Forward only to remote loopback:
  - Remote destination is always `127.0.0.1:<remotePort>`.
  - Local bind address is always `127.0.0.1`.
- Fail fast:
  - Set `-o ExitOnForwardFailure=yes`.
- Lifecycle:
  - Port-forward process lifetime is tied to the run.
  - Cancellation/shutdown tears down forwarding.

CLI command (first-class; implemented in this task):

- `chimera-bench targets forward <profileId> --remote-port <port>`
  - Establishes `127.0.0.1:<localEphemeralPort> -> 127.0.0.1:<remotePort>`.
  - Prints the chosen local port.
  - Stays running until Ctrl+C, then tears down the forward.
  - Remote host is always `127.0.0.1` in this phase (loopback-only policy).

Examples:

- `chimera-bench targets forward lab --remote-port 8080`

Manual Testing:

Prereq: start a temporary HTTP server on the remote host bound to loopback, for example:

- Remote: `python3 -m http.server 8080 --bind 127.0.0.1`

1. Create a `lab` target profile (Task 1).
2. Open a port forward with the first-class CLI (keeps running until Ctrl+C):
   - `chimera-bench targets forward lab --remote-port 8080`
   - Or via just: `just targets -- forward lab --remote-port 8080`
   - Note the printed local port (ephemeral).
3. From another shell on the orchestrator machine, confirm the forwarded port responds:
   - `curl -i http://127.0.0.1:<localPort>/`
4. Stop the helper and confirm the forwarded port is no longer reachable.
5. Validate forward failure:
   - Attempt to forward to a remote port that is not listening.
   - Confirm the helper fails fast (no long hang) and surfaces an actionable error.

### Task 4 - Run config: add `target.type = ssh` and remote model allowlisting

Extend `POST /runs` schema and normalization to support SSH targets.

This task introduces a breaking type change to the engine plugin contract: `EngineRunConfig.target` becomes a discriminated union.

Schema notes:

- Represent `target` as a discriminated union on `target.type` in both server-side validation and OpenAPI.
  - Prefer including an OpenAPI `discriminator` for SDK generation.
- Keep each target branch strict:
  - `target.type=local` rejects unknown keys (for example `profileId`).
  - `target.type=ssh` requires `profileId`.

Run config addition:

```json
{
  "target": { "type": "ssh", "profileId": "lab" },
  "model": { "identifier": "/models/my-model.gguf" }
}
```

Validation rules for SSH runs:

- `target.profileId` must reference an existing stored target profile.
- Engine must support SSH targets:
  - Extend engine capabilities with `sshTarget: boolean`.
  - `GET /engines` must expose this capability.
  - `POST /runs` must reject `target.type=ssh` when the selected engine has `sshTarget=false`.
    - Error code: `ENGINE_TARGET_NOT_SUPPORTED`.
- `model.identifier` for SSH is a remote absolute path and must end with `.gguf`.
- `model.identifier` must be within the profile's `remoteModelRoots`.
  - Path normalization (lexical; remote filesystem is not consulted):
    - Require the raw string starts with `/`.
    - Reject control characters (including `\0`, newlines, tabs).
    - Reject any identifier containing a literal `..` path segment *before* normalization.
      - Example rejected input (even though it would normalize within `/models`): `/models/subdir/../model.gguf`.
    - Normalize with `path.posix.normalize`.
    - Normalize each root with `path.posix.normalize` and trim trailing `/`.
    - Root boundary check must be slash-aware:
      - A root `/models` matches `/models/x.gguf`.
      - A root `/models` does NOT match `/models2/x.gguf`.
      - Implement as: `candidate === root` OR `candidate.startsWith(root + "/")`.
    - Even if `remoteModelRoots` includes `/`, traversal segments are still rejected.
- Persist SSH target metadata in `result.json`:
  - `target` is already required by the run result schema (`local` | `ssh`).
  - Add `targetProfileId` as an optional top-level field, required when `target === "ssh"`.

Stable error codes:

- `VALIDATION_TARGET_INVALID`
- `VALIDATION_TARGET_PROFILE_NOT_FOUND`
- `VALIDATION_MODEL_IDENTIFIER_INVALID`
- `ENGINE_TARGET_NOT_SUPPORTED`
- `TARGET_PROFILE_PERSIST_FAILED` (500; target profile store read failure)

Expected implementation touchpoints (non-exhaustive):

- Request schema + OpenAPI: `src/server/api/schemas.ts`, `src/server/api/openapi.ts`
- Plugin interface type: `src/server/engines/engine-plugin.ts`
- Run route validation/building: `src/server/routes/run-routes.ts`
- Run store metadata: `src/server/runs/in-memory-run-store.ts`
- Result persistence shape: `src/server/runs/run-orchestrator.ts` (or wherever `result.json` is assembled)
- Tests that construct run configs or assert OpenAPI schema.

Manual Testing:

Prereq: create a `lab` target profile (Task 1).

1. Confirm engine list exposes SSH capability:
   - `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/engines`
   - Confirm `llama-cpp` includes `sshTarget: true` after Task 5 is implemented.
2. Attempt to create a run with a non-existent `target.profileId` and confirm `400 VALIDATION_TARGET_PROFILE_NOT_FOUND`.
   - Note: omitting `profileId` entirely should fail request validation (`400 VALIDATION_BODY_INVALID`).
3. Attempt to create a run with a relative model path (e.g. `models/x.gguf`) and confirm validation error.
4. Attempt to create a run with a path outside allowed roots and confirm validation error:
   - Profile root: `/models`
   - Model identifier: `/tmp/evil.gguf`
5. Attempt to create an SSH run against an engine that does not support SSH (if available) and confirm `400 ENGINE_TARGET_NOT_SUPPORTED`.
6. Create a run with an allowlisted model path and confirm the run is accepted (`202`) and stored with `target=ssh`.
7. After Task 5 is implemented and a run completes, fetch the run result and confirm it includes top-level `targetProfileId`.

### Task 5 - `llama-cpp` plugin: managed remote `llama-server` execution over SSH

Extend the existing `llama-cpp` plugin to support `target.type=ssh`.

Implementation note (maintainability): the existing `src/server/engines/starter-engine.ts` is already large. Prefer extracting SSH-specific logic into a dedicated module (for example `starter-engine-ssh.ts`) while sharing validation/config helpers.

Remote execution strategy (recommended):

- Use a single `ssh` session per run that:
  - establishes a local forward `127.0.0.1:<localPort> -> 127.0.0.1:<remotePort>`
  - runs `llama-server` on the remote host in the foreground (`exec ...`)

This couples lifecycle: killing the local `ssh` process ends the remote server and the tunnel.

Remote startup requirements:

- Bind `llama-server` to remote loopback only (`--host 127.0.0.1`).
- Disable Web UI (`--no-webui`).
- Generate a per-run API key:
  - cryptographically random
  - never logged
  - never persisted in run artifacts
  - Prefer passing the key via a safer mechanism if the installed `llama-server` supports it (for example an environment variable or reading from a file). If not available, pass via `--api-key` and accept the limitation below.
  - Known limitation: if passed as `--api-key <value>` in argv, the key may be visible to other users on the remote host via process listings (`ps`). This mode assumes the remote host is in the same trust domain / single-user. Operator docs must call this out.
- Choose a remote port (retry on bind/start failure).
  - Recommended approach: pick a random port in a dedicated range (e.g. `18000..28000`) and retry a bounded number of times (e.g. 10 attempts) when the remote server exits early with a bind/listen failure.
  - If multiple SSH runs can be active concurrently against the same destination, add an in-process reservation layer to avoid reusing the same remote port across concurrent runs.
- Perform readiness checks via the forwarded local URL (`GET /health`).
  - Treat transient connection errors (for example `ECONNREFUSED`, "fetch failed", and "socket connection was closed unexpectedly") as retryable until the readiness timeout elapses.

Remote command composition:

- The plugin must assemble remote commands from argv and quote with the POSIX quoting helper from Task 2.
- Do not interpolate unescaped strings into the remote command.
- Remote commands must use `exec` so the remote `llama-server` PID is directly tied to the SSH session lifetime.

Example (conceptual) SSH-managed launch shape (API key redacted):

```text
ssh \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=yes \
  -o ForwardAgent=no \
  -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:18080:127.0.0.1:28080 \
  ubuntu@10.0.0.10 \
  'exec llama-server --model /models/model.gguf --host 127.0.0.1 --port 28080 --no-webui --api-key [REDACTED]'
```

Remote strict validation requirements:

- When `validationMode=strict`, discover supported flags on the remote host by running:
  - `<llamaServerPath> --help`
- Cache the discovered flag set for a short TTL (for example 60s) to avoid re-running `--help` for every sweep run.
  - Cache key should include connection identity, not just `profileId`.
    - Recommended minimum: `(profileId, host, port, username, auth method, llamaServerPath)`.
  - Some `llama-server` builds exit non-zero for `--help` while still printing a full flag list; treat non-zero as acceptable as long as output parses and required markers are present.
- Parse and validate `engine.serverArgs` against the discovered flags (same reserved/denylisted behavior as local mode).
- In `permissive` mode, continue to denylist dangerous flags even if unknown flags are allowed.

Remote `llamaServerPath` validation:

- In strict mode, treat `llamaServerPath` as valid only if the remote `--help` output contains expected markers used by this plugin (at minimum: `--no-webui`, `--api-key`/`--api_key`, `--model`, `--host`, `--port`).
- If markers are missing, fail validation with an actionable error (likely wrong binary/version).

Failure handling and sweep stability:

- If the remote server exits early (including OOM kill), fail the run with a stable `ENGINE_*` error and include bounded stdout/stderr excerpts.
- If SSH itself fails (connect/auth/host key), fail the run with a stable `REMOTE_SSH_FAILED` (or similar) code and include a bounded excerpt of SSH stderr.
- On cancellation/timeouts, terminate the local `ssh` process and ensure the run transitions to `cancelled`.
- Best-effort cleanup must not leak remote `llama-server` processes while the orchestrator remains alive.

Observability (required diagnostics):

- Emit structured diagnostics (EngineDiagnostic) at key points so operators can debug failures:
  - SSH session start (destination, profileId, redacted auth mode)
  - Port-forward established (localPort, remotePort)
  - Remote `--help` discovery started/completed (strict mode)
  - Remote `llama-server` start attempted (selected remote port)
  - Readiness succeeded/failed (health URL, bounded error excerpt)
  - Remote process exit (exit code/signal, bounded stderr/stdout excerpts)
  - Cleanup complete

Orchestrator crash behavior (documented limitation):

- Because the remote server runs in the foreground under the SSH session, an orchestrator crash should usually terminate the SSH session and stop the remote `llama-server`.
- This is not a hard guarantee for all environments; operator docs must include a cleanup section (how to find and terminate stale `llama-server` processes on the remote host).

Manual Testing:

Prereqs:

- Remote host is reachable via SSH with `BatchMode=yes` and strict known-hosts.
- Remote host has `llama-server` installed and callable as `llama-server` (or set `llamaServerPath`).
  - Note: non-interactive SSH command environments often differ from interactive shells; if `llama-server` is only found in an interactive session, set `llamaServerPath` to an absolute path (for example `/home/user/llama.cpp/llama-server`).
- Remote host has a model at an allowlisted path (example: `/models/model.gguf`).

1. Create a `lab` target profile (Task 1) with `remoteModelRoots` containing the model directory.
2. Start the chimera-bench server.
3. Start a remote run:
   - `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD -H 'Content-Type: application/json' http://127.0.0.1:4096/runs -d '{"engineId":"llama-cpp","target":{"type":"ssh","profileId":"lab"},"model":{"identifier":"/models/model.gguf"},"engine":{"serverArgs":["--ctx-size","2048","--parallel","1","--no-warmup"],"requestParams":{}},"validationMode":"permissive"}'`
   - If this fails due to OOM or GPU allocation issues, retry with CPU-only layers:
     - add `"--n-gpu-layers","0"` to `engine.serverArgs`.
4. Confirm readiness over the forwarded port:
   - Watch run SSE (`GET /runs/:runId/event`) and confirm it transitions to `running` only after readiness succeeds.
5. Confirm remote server is not exposed publicly:
   - On the remote host: `ss -ltnp | rg llama-server` (or equivalent)
   - Confirm it listens only on `127.0.0.1:<remotePort>`.
   - `remotePort` should be visible in orchestrator diagnostics for the run (SSH session start / port-forward established).
6. Cancellation behavior:
   - Cancel: `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD -X POST http://127.0.0.1:4096/runs/RUN_ID/cancel`
   - Confirm:
      - the local `ssh` process exits
      - the remote `llama-server` process is no longer running
   - (Optional) After a completed run, confirm the remote `llama-server` process is also gone (best-effort).
7. Strict flag discovery:
   - Run with `"validationMode":"strict"` and intentionally include an unknown flag in `engine.serverArgs`.
   - Confirm `400 VALIDATION_ENGINE_OPTIONS_INVALID` (or equivalent engine validation failure).

   Example request:

   - `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD -H 'Content-Type: application/json' http://127.0.0.1:4096/runs -d '{"engineId":"llama-cpp","target":{"type":"ssh","profileId":"lab"},"model":{"identifier":"/models/model.gguf"},"engine":{"serverArgs":["--not-a-real-flag"],"requestParams":{}},"validationMode":"strict"}'`
8. OOM/crash stability (best-effort):
   - Choose a configuration likely to fail (e.g., too-large context / GPU layers) and confirm:
     - the run fails deterministically
     - the result contains bounded error excerpts
      - subsequent runs still work (no leaked tunnel/server processes).
9. SSH failure diagnostics:
   - Create a profile with an unreachable host (example: `203.0.113.123`) and start an SSH run.
   - Confirm the run fails with a stable SSH-related error code (for example `REMOTE_SSH_FAILED`) and includes a bounded SSH stderr excerpt.
10. Strict `--help` caching (best-effort; requires Task 5 diagnostics to be implemented):
   - Run two strict-mode runs back-to-back.
   - Confirm logs/diagnostics indicate remote `--help` discovery happens once within the TTL window.
11. Orchestrator crash behavior (optional, manual):
   - Start a remote run and while it is `running`, kill the orchestrator server process.
   - On the remote host, confirm the remote `llama-server` process is not left running (best-effort expectation).

### Task 6 - Docs and tests (including gated SSH integration)

Docs:

- Add operator docs covering:
  - choosing deployment model #1 vs #2
  - strict host key setup (`known_hosts`)
  - `ssh-agent` vs key-path auth
  - POSIX shell requirement for remote SSH user (avoid `fish`/`csh` login shells)
  - remote model root allowlisting
  - interpreting remote-mode metrics (network included)
  - common failure modes (host key mismatch, auth failure, remote port conflicts, OOM kills)
  - `targets exec` security gate (`CHIMERA_ENABLE_TARGETS_EXEC=1`) and why it exists
  - API key visibility limitation on remote hosts (`ps`/process listing) and the assumption/trust model
  - orchestrator crash / orphan cleanup guidance (how to find/kill stale remote `llama-server`)
  - `$PATH` trust on the orchestrator (system `ssh` resolution)
  - how SSH timeouts interact with run timeouts (connect timeout vs run timeout vs keepalive)

Tests:

- Unit tests:
  - profile schema validation
  - remote model path normalization and allowlist checks
  - POSIX shell quoting helper (especially quotes/spaces and adversarial metacharacters)
  - property-based / corpus tests for quoting round-trips through a local `sh -c` execution
  - SSH argv construction snapshot tests (host, port, username, key-path with spaces, options ordering)
  - `llamaServerPath` allowlist validation
  - capability plumbing (`sshTarget` surfaced in `/engines`)
- Integration tests:
  - `/targets` route behavior and persistence
  - `/targets` deletion
  - `POST /runs` validation for `target.type=ssh`
- Optional gated SSH integration tests:
  - `CHIMERA_SSH_TEST=1` runs tests that require a real SSH host.
  - Provide a documented local harness option using Docker `sshd` so the tests can be run without a dedicated remote machine.

Manual Testing:

1. Follow the new operator doc end-to-end on a clean shell:
   - create a target profile
   - validate known_hosts behavior
   - run a remote benchmark
   - cancel a remote run
2. Validate no secrets are persisted:
   - `rg -n "api[-_ ]?key|Authorization" runs/ ~/.chimera-bench/targets/` (expect no matches)
3. Run the gated SSH integration test path (only when a test host is available):
   - `export CHIMERA_SSH_TEST=1`
   - `CHIMERA_SSH_TEST=1 just test` (or `CHIMERA_SSH_TEST=1 bun test`) and confirm the SSH-gated suite runs and passes.
4. (Optional) Run gated SSH tests locally via a Docker sshd harness:
   - Generate a throwaway key:
     - `ssh-keygen -t ed25519 -N '' -f /tmp/chimera-ssh-test-key`
   - Start an sshd container on localhost:2222 (example using `lscr.io/linuxserver/openssh-server:latest`):

     ```bash
     mkdir -p /tmp/chimera-sshd-config
     docker rm -f chimera-sshd >/dev/null 2>&1 || true
     docker run -d \
       --name chimera-sshd \
       -e PUID="$(id -u)" \
       -e PGID="$(id -g)" \
       -e TZ=Etc/UTC \
       -e USER_NAME=chimera \
       -e PASSWORD_ACCESS=false \
       -e SUDO_ACCESS=false \
       -e PUBLIC_KEY="$(cat /tmp/chimera-ssh-test-key.pub)" \
       -p 2222:2222 \
       -v /tmp/chimera-sshd-config:/config \
       --restart unless-stopped \
       lscr.io/linuxserver/openssh-server:latest
     ```

   - Add the container's host key to `~/.ssh/known_hosts`:
     - `ssh-keyscan -H -p 2222 127.0.0.1 >> ~/.ssh/known_hosts`
   - Create a target profile pointing at `127.0.0.1:2222` with key-path auth:
     - `curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD -H 'Content-Type: application/json' http://127.0.0.1:4096/targets -d '{"schemaVersion":1,"id":"docker-sshd","displayName":"Docker sshd","host":"127.0.0.1","port":2222,"username":"chimera","auth":{"method":"key-path","privateKeyPath":"/tmp/chimera-ssh-test-key"},"remoteModelRoots":["/config"],"llamaServerPath":"llama-server"}'`
   - Run smoke commands:
     - `chimera-bench targets check docker-sshd`
     - `CHIMERA_ENABLE_TARGETS_EXEC=1 chimera-bench targets exec docker-sshd -- echo ok`
   - Run gated tests:
     - `CHIMERA_SSH_TEST=1 just test`
   - Cleanup:
     - `docker rm -f chimera-sshd`

## Exit criteria

- A user can execute a benchmark run remotely over SSH (deployment model #2) and retrieve a local `result.json` with correct terminal status.
- Remote runs do not expose remote inference ports (loopback-only + SSH port-forward).
- Cancellation reliably tears down the tunnel and remote process in the common case.

## Dependencies

- Requires `server-plugin-llama-cpp-foundation`.
