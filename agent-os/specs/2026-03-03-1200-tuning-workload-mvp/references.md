# References for Tuning Workload MVP

## Internal repo references

- Built-in workload baseline: `src/server/runs/starter-workload.ts`
- Prompt hardening tests: `tests/starter-workload.test.ts`
- Run orchestration + result persistence: `src/server/runs/run-orchestrator/`
- Token estimation used for `contextTokens`/`outputTokens`: `src/server/runs/token-estimation.ts`
- Run route validation of `workloadId`: `src/server/routes/run-routes/index.ts`
- Run API smoke + persistence tests: `tests/app-runs/`
- SSH mixed-GPU validation guard: `src/server/engines/starter-engine/mixed-gpu-guard.ts`
- Remote `llama-server --help` parsing: `src/server/engines/starter-engine/help-discovery.ts`
- Remote help cache + dependency wiring: `src/server/engines/starter-engine/dependencies.ts`
- Remote help cache utilities (TTL sweep + bounded eviction): `src/server/engines/starter-engine/cache-utils.ts`
- Shared starter-engine flag helpers: `src/server/engines/starter-engine/utils.ts`
- Run validation error envelope + console guidance logging: `src/server/routes/run-routes/index.ts`
- Starter engine tests (SSH + validation): `tests/starter-engine/`
- Starter dependency cache behavior tests: `tests/starter-engine/dependencies.ts`
- Post-v0.0.1 selector-value validation follow-up: `agent-os/specs/2026-02-23-1716-workload-packs-and-exports/plan.md`
- Roadmap (implementation order): `agent-os/product/roadmap.md`

## External references

- llama.cpp: https://github.com/ggml-org/llama.cpp
