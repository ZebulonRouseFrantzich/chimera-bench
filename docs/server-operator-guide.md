# Server Operator Guide

This guide covers day-1 operations for the Spec 1 server (`llama-server` backend only).

## Install and verify `llama-server`

`chimera-bench` does not install `llama.cpp` for you. Install/build `llama-server` using the upstream project instructions:

- <https://github.com/ggml-org/llama.cpp>

Before running the benchmark server, verify the binary is on `PATH`:

```bash
llama-server --help
```

If this command fails, run setup again or update your shell `PATH`.

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
- `VALIDATION_MODEL_IDENTIFIER_INVALID`: model path missing, unreadable, not `.gguf`, or outside `CHIMERA_MODEL_ROOTS`.
- `VALIDATION_ENGINE_OPTIONS_INVALID`: reserved/denylisted/unknown engine args or invalid request params.
- `RUN_CONCURRENCY_LIMIT`: only one active run is allowed.
- `RUN_RESULT_PERSIST_FAILED`: disk write failure while persisting `runs/{runId}/result.json`.
- `AUTH_REQUIRED` / `AUTH_RATE_LIMITED`: missing/invalid credentials or repeated auth failures.

## Observability and diagnostics

- Every JSON response includes `meta.requestId` and `X-Request-Id`.
- Run lifecycle and engine diagnostics log with `runId`.
- Engine startup/readiness failures include bounded stdout/stderr excerpts.
- Engine API keys are redacted from diagnostics.
- Optional dev-mode access logs: set `CHIMERA_BENCH_DEV=1`.
