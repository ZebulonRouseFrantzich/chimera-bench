# Tech Stack

This project is intended to follow a split server/client architecture inspired by OpenCode, with the option to run both together or separately across machines.

## Frontend

- Vue.js is preferred.
- Final frontend choice is decided in Spec 7 (Vue vs Solid) before client implementation.
- Client integrations should be generated from OpenAPI and consume server event streams.

## Backend

- Bun + TypeScript backend server process for orchestration and control.
- Hono for HTTP routing with zod validation and OpenAPI 3.1 docs at `/doc`.
- Headless `chimera-bench serve` mode with network flags (`--port`, `--hostname`, repeatable `--cors`, optional `--mdns`).
- Plugin-based engine interface for benchmark backends (first plugin: `llama.cpp`).
- Managed `llama-server` subprocess lifecycle for repeatable runs and clean restarts.

## Database

N/A for initial phases; benchmark outputs are stored as files (`result.json`, `cases.csv`, `summary.md`).

## Other

- `llama.cpp` / `llama-server` for initial local model inference and benchmarking.
- SSH for running benchmarks on remote machines while centralizing run metadata and artifacts.
- Server-sent events (`/event`) for long-running run progress.
- Security hardening for exposed server mode and remote secret handling.
- Planned engine expansion to `vLLM` and `exo`.
