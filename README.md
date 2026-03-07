![Status: pre-pre-alpha](https://img.shields.io/badge/status-pre--pre--alpha-red)

# chimera-bench

A multi-ability LLM benchmark runner

## Install

- curl installer:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/ZebulonRouseFrantzich/chimera-bench/main/install | bash
  ```

- npm global install:

  ```bash
  npm i -g chimera-bench
  ```

- bun global install:

  ```bash
  bun add -g chimera-bench
  ```

Optional installer version pin:

```bash
curl -fsSL https://raw.githubusercontent.com/ZebulonRouseFrantzich/chimera-bench/v<VERSION>/install | bash -s -- --version <VERSION>
```

Notes:

- npm-based installs require Node.js 20 or newer.
- Current binary releases target macOS (`arm64`, `x64`) and Linux glibc (`x64 baseline`, `arm64`).
- Windows is covered in CI, but Windows release binaries are not published yet.
- Homebrew and AUR/paru support are planned as future additions.

## Install troubleshooting

- Update to latest npm package:

  ```bash
  npm update -g chimera-bench
  # or
  bun add -g chimera-bench@latest
  ```

- If your shell still points to a removed global shim path after uninstalling a
  different install method, refresh command lookup with `hash -r` or open a new
  shell.

- Custom release repositories are blocked by default for the curl installer.
  For explicit internal-testing opt-in, set:

  ```bash
  CHIMERA_BENCH_ALLOW_CUSTOM_REPO=1 CHIMERA_BENCH_RELEASE_REPO=owner/repo curl -fsSL https://raw.githubusercontent.com/ZebulonRouseFrantzich/chimera-bench/main/install | bash
  ```

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

## Prerequisites (llama.cpp)

`chimera-bench` uses `llama-server` from llama.cpp. Install/build it and ensure it is on your `PATH`:

```bash
llama-server --help
```

`chimera-bench` does not download models for you; you need a local `.gguf` file.

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
- Filesystem workload packs can be discovered from `CHIMERA_WORKLOAD_ROOTS`.
- CORS allowlist: `--cors <origin>` (repeatable).
- mDNS advertisement: `--mdns` (default domain `chimera.local`, override with `--mdns-domain`).
- Proxy mode: set `CHIMERA_SERVER_TRUST_PROXY=1` only behind a trusted reverse proxy (affects auth rate limiting).
- Global SSE: `GET /event`.

## Run a benchmark

List engines:

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/engines
```

List available workloads:

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/workloads
```

Create a run (defaults to built-in `starter.v2` workload):

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD \
  -H "Content-Type: application/json" \
  http://127.0.0.1:4096/runs \
  -d '{"engineId":"llama-cpp","target":{"type":"local"},"model":{"identifier":"/absolute/path/to/model.gguf"}}'
```

Watch run events (SSE):

```bash
curl -N -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/runs/<runId>/event
```

Read status, cancel, and fetch the persisted result:

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/runs/<runId>
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD -X POST http://127.0.0.1:4096/runs/<runId>/cancel
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/runs/<runId>/result
```

Notes:

- Only one active run is allowed at a time.
- Results are persisted to `runs/<runId>/result.json`.
- `validationMode` defaults to `strict`; set `permissive` to experiment with unknown `engine.serverArgs` / `engine.requestParams`.

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
