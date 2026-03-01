![Status: pre-pre-alpha](https://img.shields.io/badge/status-pre--pre--alpha-red)

# chimera-bench

A multi-ability LLM benchmark runner

## Nix (optional)

This repo includes a Nix flake for a reproducible dev shell.

- With direnv: `direnv allow`
- Manual shell: `just shell`

## Development

- Install deps: `just install`
- Typecheck: `just lint`
- Tests: `just test`
- Generate OpenAPI contract: `bun run openapi:generate`
- Generate SDK scaffolding: `bun run sdk:generate`
- Check OpenAPI/SDK drift: `bun run openapi:check`

## Run the server

Start (loopback, no auth by default):

```bash
just serve
curl -sS http://127.0.0.1:4096/global/health
```

Expose on LAN (requires auth + model roots):

```bash
export CHIMERA_SERVER_PASSWORD="$(openssl rand -base64 24)"
export CHIMERA_MODEL_ROOTS=/absolute/path/to/models
just serve -- --hostname 0.0.0.0 --port 4096
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/global/health
```

Notes:

- Basic auth: `CHIMERA_SERVER_PASSWORD` enables auth; `CHIMERA_SERVER_USERNAME` defaults to `chimera`.
- Non-loopback binds require a strong password (`CHIMERA_SERVER_PASSWORD`) and model-root confinement (`CHIMERA_MODEL_ROOTS`).
- CORS allowlist: `--cors <origin>` (repeatable).
- Global SSE: `GET /event`.

## API docs and generated artifacts

- Live OpenAPI docs are served at `GET /doc`.
- Generated OpenAPI contract is written to `openapi/openapi.json`.
- Generated SDK scaffolding is written to `sdk/generated/`.

Regenerate after route/schema changes:

```bash
bun run openapi:generate
bun run sdk:generate
```

Verify artifacts are in sync:

```bash
bun run openapi:check
```

## Operator guide

See `docs/server-operator-guide.md` for `llama-server` install checks, safe LAN setup, and common failure-mode triage.

## Dev mode

Set `CHIMERA_BENCH_DEV=1` when running `chimera-bench serve` to enable verbose request access logs. Default is off.
