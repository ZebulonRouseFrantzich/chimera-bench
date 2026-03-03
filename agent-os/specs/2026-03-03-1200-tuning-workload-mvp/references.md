# References for Tuning Workload MVP

## Internal repo references

- Built-in workload baseline: `src/server/runs/starter-workload.ts`
- Run orchestration + result persistence: `src/server/runs/run-orchestrator/`
- Token estimation used for `contextTokens`/`outputTokens`: `src/server/runs/token-estimation.ts`
- Run route validation of `workloadId`: `src/server/routes/run-routes/index.ts`
- Run API smoke + persistence tests: `tests/app-runs/`
- Roadmap (implementation order): `agent-os/product/roadmap.md`

## External references

- llama.cpp: https://github.com/ggml-org/llama.cpp
