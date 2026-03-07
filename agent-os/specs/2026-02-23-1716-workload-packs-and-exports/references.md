# References for Workload Packs and Exports

## Inspiration

- llama-benchy (real-world prompt style and TTFT emphasis): https://github.com/eugr/llama-benchy
- llama.cpp baseline: https://github.com/ggml-org/llama.cpp

## Internal repo references

- Applied standards (embedded for offline review): `agent-os/specs/2026-02-23-1716-workload-packs-and-exports/standards.md`
- API conventions: `agent-os/standards/server/api-conventions.md`
- Server log line format: `agent-os/standards/server/log-line-format.md`
- Run result schema: `agent-os/standards/runs/result-schema.md`
- Run artifact store standard: `agent-os/standards/runs/artifact-store.md`
- TTL cache + in-flight dedupe: `agent-os/standards/global/ttl-cache-and-inflight-dedupe.md`
- Time-based testing helpers: `agent-os/standards/global/time-based-testing.md`
- Run artifact persistence: `agent-os/specs/2026-02-23-1715-server-plugin-llama-cpp-foundation/plan.md`
- v0.1.0 sweep orchestration dependency: `agent-os/specs/2026-02-23-1717-sweep-engine-run-orchestration/plan.md`
- SSH mixed-GPU validation context (v0.0.1): `agent-os/specs/2026-03-03-1200-tuning-workload-mvp/plan.md`
- Sweep MVP prompt-fit validation context (v0.0.1): `agent-os/specs/2026-03-03-1210-sweep-mvp/review-findings.md`
- llama-server prompt token preflight reference (uses `/tokenize`):
  - `src/server/engines/starter-engine/prompt-fit-preflight.ts`
  - `src/server/engines/starter-engine/utils.ts`
- Run artifact store (atomic writes + path confinement):
  - `src/server/runs/run-artifact-store.ts`
  - `src/server/runs/persist-run-artifact.ts`
- Run timeouts schema + defaults:
  - `src/server/api/schemas.ts`
  - `src/server/runs/defaults.ts`
  - `src/server/routes/run-routes/index.ts`
  - Tests:
    - `tests/app-runs/timeouts-and-startup-failures.ts`
    - `tests/app-runs/request-validation-core.ts`
    - `tests/app-runs/results-persistence.ts`
- Engine validation + SSH GPU hints (implementation):
  - `src/server/engines/starter-engine/mixed-gpu-guard.ts`
  - `src/server/engines/starter-engine/help-discovery.ts`
  - `src/server/engines/starter-engine/dependencies.ts`
  - `src/server/engines/starter-engine/run-config-validation.ts`
  - `src/server/routes/run-routes/index.ts`

- CLI command patterns (for `workloads validate`):
  - Standards:
    - `agent-os/standards/cli/arg-parsing.md`
    - `agent-os/standards/cli/exit-codes.md`
  - Entry points:
    - `src/cli.ts`
    - `bin/chimera-bench`
    - `src/cli/serve-command.ts`

- OpenAPI + SDK artifacts (generation + drift checks):
  - Standards: `agent-os/standards/server/openapi-and-sdk-artifacts.md`
  - Source of truth:
    - `src/server/api/schemas.ts`
    - `src/server/api/openapi/index.ts`
    - `src/server/api/openapi/register-run-paths.ts`
    - `src/server/api/openapi/register-global-engine-paths.ts`
    - `src/server/api/openapi/register-target-paths.ts`
  - Scripts:
    - `scripts/openapi-artifacts.ts`
    - `scripts/generate-openapi.ts`
    - `scripts/check-openapi-drift.ts`
    - `scripts/generate-sdk.ts`
  - Generated artifacts:
    - `openapi/openapi.json`
    - `sdk/generated/client.ts`
    - `sdk/generated/index.ts`
