# References for Sweep MVP

## Internal repo references

- Run creation route wiring: `src/server/routes/run-routes/index.ts`
- Create-run request schema (zod + OpenAPI): `src/server/api/schemas.ts`
- Run OpenAPI path registration: `src/server/api/openapi/register-run-paths.ts`

- Request param budget validation (node/depth/string limits): `src/server/api/schemas.ts`
- Reserved/denylisted server args + reserved request param keys (llama.cpp plugin): `src/server/engines/starter-engine/run-config-validation.ts`
- Reserved/denylisted flag sets: `src/server/engines/starter-engine/constants.ts`

- llama.cpp plugin case execution (Task 6):
  - `src/server/engines/starter-engine/index.ts`
  - `src/server/engines/starter-engine/case-execution.ts`
  - `src/server/engines/starter-engine/chat-completions-response.ts`
  - `src/server/engines/starter-engine/http-response-limit.ts`
  - `src/server/engines/starter-engine/prompt-fit-preflight.ts`

- Run orchestration (single-run baseline): `src/server/runs/run-orchestrator/`
- Run store + per-case outcomes: `src/server/runs/in-memory-run-store/`
  - Case outcome recording: `src/server/runs/in-memory-run-store/case-outcomes.ts`
  - Result builder (persisted `result.json` shape): `src/server/runs/in-memory-run-store/results.ts`
- Run artifact persistence: `src/server/runs/run-artifact-store.ts`

- Run result schema standard: `agent-os/standards/runs/result-schema.md`
- Engine interface: `agent-os/standards/plugins/engine-interface.md`
- Roadmap (implementation order): `agent-os/product/roadmap.md`

- Existing run-route tests to extend:
  - `tests/app-runs/`
  - `tests/app-runs/request-validation-core.ts`
  - `tests/app-runs/engine-validation.ts`
  - `tests/app-runs/results-persistence.ts`

## Related specs

- Full sweep orchestration (post-v0.0.1): `agent-os/specs/2026-02-23-1717-sweep-engine-run-orchestration/`
- Engine + server foundation: `agent-os/specs/2026-02-23-1715-server-plugin-llama-cpp-foundation/`
- Workload prompt packs + exports (future scenarios/prompt calibration surface):
  `agent-os/specs/2026-02-23-1716-workload-packs-and-exports/`

## Review notes

- Tasks 1-2 review findings and decisions: `agent-os/specs/2026-03-03-1210-sweep-mvp/review-findings.md`
- PR #21 follow-up: temporary `VALIDATION_SWEEP_NOT_SUPPORTED` gate remains in
  Task 2 and must be removed by Task 3/4 implementation.
