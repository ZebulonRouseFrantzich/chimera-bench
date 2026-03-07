# Standards for Workload Packs and Exports

This spec references canonical standards by file path.
Do not duplicate standards text here; use the source files below directly.

## Canonical standards

- `agent-os/standards/server/api-conventions.md`
- `agent-os/standards/runs/result-schema.md`
- `agent-os/standards/runs/artifact-store.md`
- `agent-os/standards/runs/built-in-workload-hardening.md`
- `agent-os/standards/global/sanitization-and-safe-errors.md`
- `agent-os/standards/server/log-line-format.md`
- `agent-os/standards/global/ttl-cache-and-inflight-dedupe.md`
- `agent-os/standards/global/time-based-testing.md`
- `agent-os/standards/server/openapi-and-sdk-artifacts.md`
- `agent-os/standards/server/request-param-budgets.md`
- `agent-os/standards/cli/arg-parsing.md`
- `agent-os/standards/cli/exit-codes.md`

## Usage notes

- Source of truth is `agent-os/standards/`.
- If a referenced standard changes, implementations of this spec must use the latest version at that path.
- Keep `plan.md` "Standards applied" aligned with this file.
