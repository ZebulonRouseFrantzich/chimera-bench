# Product Roadmap

This file is the canonical implementation order for `agent-os/specs/*`.

# Tooling (Anytime)

- Local Development Environment (Nix Flake) (`agent-os/specs/2026-02-24-1905-local-dev-env-nix-flake/`)
  - Reproducible contributor tooling (`flake.nix`, `.envrc`, `Justfile`) without changing end-user UX.

Rules:

- Specs are referenced by name + spec folder path (no numeric spec IDs in spec docs).
- Each spec entry is a checkbox so we can track completion over time.

# Upcoming Features

## v0.0.1 (SSH llama-server Sweep MVP)

- [x] Server Plugin llama.cpp Foundation (`agent-os/specs/2026-02-23-1715-server-plugin-llama-cpp-foundation/`)
  - Headless `serve` command + baseline server APIs (`/global/health`, `/event`, `/doc`), plugin registry, and first `llama.cpp` (`llama-server`) engine.
- [x] SSH Remote Execution Profiles (`agent-os/specs/2026-02-23-1720-ssh-remote-execution-profiles/`)
  - Run `llama-server` on a remote machine over SSH with safe defaults while persisting artifacts on the orchestrator host.
- [x] Tuning Workload MVP (`agent-os/specs/2026-03-03-1200-tuning-workload-mvp/`)
  - Single built-in, long/stress prompt workload for v0.0.1 sweep tuning (KV-cache and OOM sensitivity).
- [x] Sweep MVP (`agent-os/specs/2026-03-03-1210-sweep-mvp/`)
  - Minimal deterministic sweep expansion (explicit lists), restart-per-case execution, and best-to-worst ranking in `result.json`.

## v0.1.0 (Portable Workloads + Full Sweeps)

- [ ] Workload Packs and Exports (`agent-os/specs/2026-02-23-1716-workload-packs-and-exports/`)
  - High-quality prompt packs + context injection + stable exports (`result.json`, `cases.csv`, `summary.md`).
- [ ] Sweep Engine Run Orchestration (`agent-os/specs/2026-02-23-1717-sweep-engine-run-orchestration/`)
  - Parameter matrix expansion, deterministic ordering, clean restarts between cases, progress events, and resume support.

## v0.2.0 (Deeper Metrics + Security Hardening)

- [ ] Log Metrics Efficiency Analysis (`agent-os/specs/2026-02-23-1718-log-metrics-efficiency-analysis/`)
  - Deep performance signals from engine logs (TTFT, prompt eval throughput, acceptance-style efficiency signals).
- [ ] Server Auth and SSH Secret Hardening (`agent-os/specs/2026-02-23-1719-server-auth-and-ssh-secret-hardening/`)
  - Harden remote/internet-facing usage (password-from-file, audit logging, redaction guarantees, SSH secret handling).

## v0.3.0 (Client MVP)

- [ ] Frontend Stack Decision (Vue vs Solid) (`agent-os/specs/2026-02-23-1721-frontend-stack-decision-vue-vs-solid/`)
  - Choose a frontend stack based on OpenAPI/SSE integration, maintainability, and ecosystem fit.
- [ ] Client Dashboard and Dual Run Mode (`agent-os/specs/2026-02-23-1722-client-dashboard-dual-run-mode/`)
  - Web client to configure runs/sweeps, monitor progress, and view exports; supports local or remote server connections.

## v0.4.0 (Engine Expansion)

- [ ] Engine Expansion (vLLM and exo) (`agent-os/specs/2026-02-23-1723-engine-expansion-vllm-exo/`)
  - Add additional engine plugins under the shared interface while preserving schema/export compatibility.
- [ ] Engine Enhancements llama.cpp Tools (`agent-os/specs/2026-02-25-1939-engine-enhancements-llama-cpp-tools/`)
  - Expand `llama.cpp` support beyond `llama-server` (e.g., `llama-cli`, `llama-bench`, HF acquisition, optional binding overrides).

# Completed Features
