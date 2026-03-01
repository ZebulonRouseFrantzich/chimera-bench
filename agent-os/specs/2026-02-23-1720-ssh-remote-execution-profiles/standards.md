# Standards for SSH Remote Execution Profiles

This spec references canonical standards by file path.
Do not duplicate standards text here; use the source files below directly.

## Canonical standards

CLI:

- `agent-os/standards/cli/arg-parsing.md`
- `agent-os/standards/cli/exit-codes.md`
- `agent-os/standards/cli/signal-shutdown.md`

Global:

- `agent-os/standards/global/sanitization-and-safe-errors.md`
- `agent-os/standards/global/time-based-testing.md`

Server:

- `agent-os/standards/server/api-conventions.md`
- `agent-os/standards/server/basic-auth.md`
- `agent-os/standards/server/cors-allowlist.md`
- `agent-os/standards/server/graceful-shutdown.md`
- `agent-os/standards/server/json-request-validation.md`
- `agent-os/standards/server/log-line-format.md`
- `agent-os/standards/server/openapi-and-sdk-artifacts.md`
- `agent-os/standards/server/serve-exposure-safety.md`
- `agent-os/standards/server/sse-streams.md`

Plugins:

- `agent-os/standards/plugins/engine-interface.md`
- `agent-os/standards/plugins/llama-cpp-api-key-and-redaction.md`
- `agent-os/standards/plugins/llama-cpp-model-identifier-validation.md`
- `agent-os/standards/plugins/llama-cpp-readiness-probe.md`
- `agent-os/standards/plugins/llama-cpp-stop-escalation.md`
- `agent-os/standards/plugins/llama-cpp-strict-flag-validation.md`
- `agent-os/standards/plugins/llama-cpp-subprocess-startup.md`

Runs:

- `agent-os/standards/runs/artifact-store.md`
- `agent-os/standards/runs/orchestrator-cancellation-timeouts.md`
- `agent-os/standards/runs/result-schema.md`
- `agent-os/standards/runs/run-events.md`

Testing:

- `agent-os/standards/testing/app-fixtures.md`
- `agent-os/standards/testing/async-polling.md`
- `agent-os/standards/testing/log-assertions.md`

## Usage notes

- Source of truth is `agent-os/standards/`.
- If a referenced standard changes, implementations of this spec must use the latest version at that path.
- Keep `plan.md` "Standards applied" aligned with this file.
