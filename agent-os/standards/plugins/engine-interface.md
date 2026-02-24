# Engine Plugin Interface

All inference backends (`llama.cpp`, `vLLM`, `exo`, etc.) implement one stable plugin contract.

## Required plugin metadata

- `id`: stable identifier (`llama-cpp`).
- `displayName`: human-friendly name.
- `version`: plugin version.
- `capabilities`: supported features (streaming, speculative decoding metrics, remote compatibility).

## Required lifecycle

Each plugin must implement these lifecycle methods:

1. `validateEnvironment()`
2. `buildLaunchConfig(runConfig)`
3. `start(context)`
4. `waitUntilReady(context)`
5. `executeCase(context, caseConfig)`
6. `collectMetrics(context)`
7. `stop(context)`

The core runner only calls this interface and must not branch on engine-specific behavior.

## Config boundaries

- Core owns generic benchmark config (`model`, `workload`, `sweep`, `target`).
- Plugin owns engine-specific config under `engine.options`.
- Keep raw pass-through support so new engine flags do not require core changes:
  - `engine.serverArgs: string[]`
  - `engine.requestParams: Record<string, unknown>`

## Metrics and parsing

- Plugins parse stdout/stderr into typed metric fragments.
- If parsing fails, keep run execution alive and mark metric as unavailable with reason.
- Include a bounded raw log excerpt for auditability when parse errors happen.

## Isolation rules

- Engine-specific command building, readiness checks, and regex parsing live in the plugin package.
- Shared utilities may be imported, but plugin logic stays self-contained.
