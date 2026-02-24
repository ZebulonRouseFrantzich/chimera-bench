# Product Roadmap

## Phase 1: Server-First MVP

- **Spec 1 - Server Plugin llama.cpp Foundation:** Build a headless `serve` command, baseline server APIs (`/global/health`, `/event`, `/doc`), plugin registry, and first `llama.cpp` plugin.
- **Spec 2 - Workload Packs and Exports:** Add high-quality benchmark prompt packs, context injection, and stable exports (`result.json`, `cases.csv`, `summary.md`).
- **Spec 3 - Sweep Engine Run Orchestration:** Implement parameter matrix expansion, deterministic run ordering, clean restarts between cases, and progress events.
- **Spec 4 - Log Metrics Efficiency Analysis:** Extract deep metrics from engine logs (TTFT, latency, prompt eval throughput, acceptance-style efficiency signals).
- **Spec 5 - Server Auth and SSH Secret Hardening:** Add secure defaults for headless server usage and remote credential handling.
- **Spec 6 - SSH Remote Execution Profiles:** Support remote benchmark execution over SSH while storing run definitions and artifacts on the orchestrator host.

## Phase 2: Client and Ecosystem Expansion

- **Spec 7 - Frontend Stack Decision (Vue vs Solid):** Finalize frontend technology based on API/SSE integration needs and long-term maintainability.
- **Spec 8 - Client Dashboard and Dual Run Mode:** Ship web client UX for configuring runs, monitoring progress, and connecting to local or remote servers; support running server/client together or separately.
- **Spec 9 - Engine Expansion (vLLM and exo):** Add additional engine plugins under the shared interface while preserving schema/export compatibility.
- Continue iterative improvements to workloads, metrics, and efficiency heuristics based on real usage.
