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

## Run the server

Start (loopback, no auth by default):

```bash
just serve
curl -sS http://127.0.0.1:4096/global/health
```

Expose on LAN (requires auth + model roots):

```bash
export CHIMERA_SERVER_PASSWORD=devpass
export CHIMERA_MODEL_ROOTS=/absolute/path/to/models
just serve -- --hostname 0.0.0.0 --port 4096
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/global/health
```

Notes:

- Basic auth: `CHIMERA_SERVER_PASSWORD` enables auth; `CHIMERA_SERVER_USERNAME` defaults to `chimera`.
- CORS allowlist: `--cors <origin>` (repeatable).
- Global SSE: `GET /event`.
