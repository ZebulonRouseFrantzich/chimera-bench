# Product Roadmap

## Foundation

- **Spec 0 - Local Development Environment (Nix Flake):** Establish reproducible contributor tooling (`flake.nix`, `.envrc`, `Justfile`) before feature implementation. This foundational spec intentionally precedes the numbered product roadmap phases below.

## Phase 1: Server-First MVP

- **Spec 1 - Server Plugin llama.cpp Foundation:** Build a headless `serve` command, baseline server APIs (`/global/health`, `/event`, `/doc`), plugin registry, and first `llama.cpp` plugin.
- **Spec 2 - SSH Remote Execution Profiles:** Support remote benchmark execution over SSH while storing run definitions and artifacts on the orchestrator host.
- **Spec 3 - Workload Packs and Exports:** Add high-quality benchmark prompt packs, context injection, and stable exports (`result.json`, `cases.csv`, `summary.md`).
- **Spec 4 - Sweep Engine Run Orchestration:** Implement parameter matrix expansion, deterministic run ordering, clean restarts between cases, and progress events.
- **Spec 5 - Log Metrics Efficiency Analysis:** Extract deep metrics from engine logs (TTFT, latency, prompt eval throughput, acceptance-style efficiency signals).
- **Spec 6 - Server Auth and SSH Secret Hardening:** Add deeper security hardening for remote/internet-facing usage (beyond Spec 1's basic auth) and SSH secret-handling rules.

## Phase 2: Client and Ecosystem Expansion

- **Spec 7 - Frontend Stack Decision (Vue vs Solid):** Finalize frontend technology based on API/SSE integration needs and long-term maintainability.
- **Spec 8 - Client Dashboard and Dual Run Mode:** Ship web client UX for configuring runs, monitoring progress, and connecting to local or remote servers; support running server/client together or separately.
- **Spec 9 - Engine Expansion (vLLM and exo):** Add additional engine plugins under the shared interface while preserving schema/export compatibility.
- Continue iterative improvements to workloads, metrics, and efficiency heuristics based on real usage.
