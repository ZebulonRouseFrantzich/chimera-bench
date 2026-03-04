# References for Workload Packs and Exports

## Inspiration

- llama-benchy (real-world prompt style and TTFT emphasis): https://github.com/eugr/llama-benchy
- llama.cpp baseline: https://github.com/ggml-org/llama.cpp

## Internal repo references

- Applied standards (embedded for offline review): `agent-os/specs/2026-02-23-1716-workload-packs-and-exports/standards.md`
- API conventions: `agent-os/standards/server/api-conventions.md`
- Run result schema: `agent-os/standards/runs/result-schema.md`
- Run artifact persistence: `agent-os/specs/2026-02-23-1715-server-plugin-llama-cpp-foundation/plan.md`
- SSH mixed-GPU validation context (v0.0.1): `agent-os/specs/2026-03-03-1200-tuning-workload-mvp/plan.md`
- Engine validation + SSH GPU hints (implementation):
  - `src/server/engines/starter-engine/mixed-gpu-guard.ts`
  - `src/server/engines/starter-engine/help-discovery.ts`
  - `src/server/engines/starter-engine/dependencies.ts`
  - `src/server/engines/starter-engine/run-config-validation.ts`
  - `src/server/routes/run-routes/index.ts`
