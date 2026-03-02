# Server Operator Guide

This guide covers day-1 operations for local and SSH remote execution with the `llama-server` backend.

## Install and verify `llama-server`

`chimera-bench` does not install `llama.cpp` for you. Install/build `llama-server` using the upstream project instructions:

- <https://github.com/ggml-org/llama.cpp>

Before running the benchmark server, verify the binary is on `PATH`:

```bash
llama-server --help
```

If this command fails, run setup again or update your shell `PATH`.

## Choose a deployment model

- Model #1 (co-located): run `chimera-bench serve` on the LLM machine.
  - Best when you want engine/hardware measurements with minimal network overhead.
- Model #2 (SSH remote execution): run `chimera-bench serve` on an orchestrator machine and control the remote LLM host over SSH.
  - Best when you want client-observed metrics that include network and tunnel overhead.

For sweeps, keep the orchestrator host, network path, and tunnel settings stable so comparisons stay meaningful.

## Prepare strict host key verification (`known_hosts`)

SSH target operations use strict host key checking (`StrictHostKeyChecking=yes`) and non-interactive mode (`BatchMode=yes`).
`chimera-bench` relies on your OpenSSH `known_hosts` file at `~/.ssh/known_hosts`.

1. Scan the host key and verify its fingerprint before trusting it:

```bash
ssh-keyscan -H <ssh-host> | tee /tmp/<ssh-host>.keyscan
ssh-keygen -lf /tmp/<ssh-host>.keyscan
```

2. Confirm the fingerprint out-of-band (for example, from your infrastructure inventory or host console), then add it to `known_hosts`:

```bash
cat /tmp/<ssh-host>.keyscan >> ~/.ssh/known_hosts
```

3. Verify access in non-interactive mode:

```bash
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes <user>@<ssh-host> "echo ok"
```

If host keys rotate or mismatch, refresh `known_hosts` intentionally (do not disable strict checking).

## SSH auth modes and profile policy

- `ssh-agent` (recommended): uses identities loaded in your local agent.
- `key-path`: stores only an absolute private key path reference in the profile.
  - Key contents and passphrases are never persisted by `chimera-bench`.
  - Keep private keys locked down (`chmod 600 /path/to/private-key`) and readable by the `chimera-bench` process user.
- Profile storage:
  - `~/.chimera-bench/targets/` (mode `0700`)
  - `~/.chimera-bench/targets/<id>.json` (mode `0600`)
- `remoteModelRoots` is an allowlist for remote `model.identifier` paths.
  - Keep this tight (for example `/models`), not broad (`/`).
- If you set `llamaServerPath` to an absolute path, its basename must still be exactly `llama-server`.

## SSH targets CLI (local profile store)

You can inspect and smoke-test SSH target profiles without running the server process:

```bash
chimera-bench targets list
chimera-bench targets show <profileId>
chimera-bench targets rm <profileId>
chimera-bench targets check <profileId>
chimera-bench targets forward <profileId> --remote-port <port>
CHIMERA_ENABLE_TARGETS_EXEC=1 chimera-bench targets exec <profileId> -- <argv...>
```

Security and compatibility notes:

- `targets exec` runs arbitrary remote commands and is disabled by default.
  - Set `CHIMERA_ENABLE_TARGETS_EXEC=1` to enable execution.
  - `--dry-run` always works and prints the constructed `ssh` argv.
  - The gate exists to reduce accidental remote-shell capability on shared orchestrators.
- Remote commands run through the SSH user's login shell.
  - The remote user must have a POSIX-compatible shell (for example `bash` or `dash`), not `fish`/`csh`.
- `ssh` is resolved from the orchestrator host `PATH`.
  - Treat orchestrator `PATH` as trusted operational configuration.

SSH-managed llama-server notes:

- For compatibility with upstream `llama-server` flags, the orchestrator passes the per-run API key via `--api-key` in the remote process argv.
  - This key is ephemeral and the remote server binds to loopback only.
  - On multi-user or shared remote hosts, other users with process visibility may still see argv values (`ps`, `/proc/<pid>/cmdline`) and recover the per-run API key and port.
  - Run SSH targets only on dedicated single-tenant hosts in the same trust domain as the orchestrator.
- If the orchestrator crashes or loses connectivity mid-run, the remote `llama-server` can remain running.
  - Verify and clean up on the remote host if needed, for example:
    - `ps aux | grep llama-server`
    - `pkill -f llama-server`

## SSH timeout model vs run timeout

Remote runs involve multiple timeout layers:

- SSH connect timeout: `ConnectTimeout=10` for each SSH session setup.
- SSH keepalive: `ServerAliveInterval=10` and `ServerAliveCountMax=3` detect dead sessions.
- Run-level timeout (`timeouts.runMs`): orchestrator budget for the entire run.

If SSH transport fails first, the run fails with an SSH-related engine error. If the run budget expires first, the run fails with timeout/cancellation semantics even if SSH is still connected.

## Start the server safely

Loopback-only (local machine):

```bash
chimera-bench serve
```

LAN exposure (requires auth + model-root confinement):

```bash
export CHIMERA_SERVER_PASSWORD="$(openssl rand -base64 24)"
export CHIMERA_MODEL_ROOTS=/absolute/path/to/models
chimera-bench serve --hostname 0.0.0.0 --port 4096 --cors http://localhost:5173
```

If you provide your own password, keep it strong (minimum 12 characters and mixed character classes).

Important LAN rules:

- Non-loopback bind is rejected when `CHIMERA_SERVER_PASSWORD` is unset.
- Non-loopback bind is rejected when `CHIMERA_SERVER_PASSWORD` is weak.
- Non-loopback bind is rejected when `CHIMERA_MODEL_ROOTS` is unset.
- CORS is deny-by-default. Add each allowed origin with `--cors`.

## Verify runtime behavior

Health:

```bash
curl -sS http://127.0.0.1:4096/global/health
```

Health with auth:

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/global/health
```

Engine discovery:

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/engines
```

OpenAPI docs:

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/doc
```

## Common failure modes

- `ENGINE_START_FAILED`: `llama-server` missing, not executable, exited early, or failed readiness.
- `REMOTE_SSH_FAILED`: SSH connect/auth/host-key failures while starting remote runs.
- `VALIDATION_MODEL_IDENTIFIER_INVALID`: model path missing, unreadable, not `.gguf`, or outside `CHIMERA_MODEL_ROOTS`.
- `VALIDATION_MODEL_IDENTIFIER_INVALID` (SSH): remote model path outside `remoteModelRoots`, not absolute, traversal segments, or not `.gguf`.
- `VALIDATION_ENGINE_OPTIONS_INVALID`: reserved/denylisted/unknown engine args or invalid request params.
- `RUN_CONCURRENCY_LIMIT`: only one active run is allowed.
- SSH forward/startup failures: remote loopback port conflicts, remote service not listening, or early remote process exit.
- Remote OOM/early exits: remote `llama-server` terminates during startup or run; diagnostics include bounded excerpts.
- `RUN_RESULT_PERSIST_FAILED`: disk write failure while persisting `runs/{runId}/result.json`.
- `AUTH_REQUIRED` / `AUTH_RATE_LIMITED`: missing/invalid credentials or repeated auth failures.

## Gated SSH integration tests

SSH integration tests are opt-in and run only when `CHIMERA_SSH_TEST=1`:

```bash
CHIMERA_SSH_TEST=1 \
CHIMERA_SSH_TEST_HOST=127.0.0.1 \
CHIMERA_SSH_TEST_PORT=2222 \
CHIMERA_SSH_TEST_USERNAME=chimera \
CHIMERA_SSH_TEST_PRIVATE_KEY_PATH=/tmp/chimera-ssh-test-key \
bun test
```

Without `CHIMERA_SSH_TEST=1`, the gated SSH tests no-op and do not require a live SSH host.

Local harness option (Docker `sshd`, throwaway key):

```bash
ssh-keygen -t ed25519 -N "" -f /tmp/chimera-ssh-test-key
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
  lscr.io/linuxserver/openssh-server:latest
for _ in $(seq 1 20); do
  if ssh-keyscan -H -p 2222 127.0.0.1 >> ~/.ssh/known_hosts 2>/dev/null; then
    break
  fi
  sleep 0.5
done
```

## Observability and diagnostics

- Every JSON response includes `meta.requestId` and `X-Request-Id`.
- Run lifecycle and engine diagnostics log with `runId`.
- Engine startup/readiness failures include bounded stdout/stderr excerpts.
- Engine API keys are redacted from diagnostics.
- Optional dev-mode access logs: set `CHIMERA_BENCH_DEV=1`.
