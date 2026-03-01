# Engine Plugin Interface

All inference backends (`llama.cpp`, `vLLM`, `exo`, etc.) implement `EnginePlugin`.
Core must not branch on engine-specific behavior.

## Registration requirements

- `apiVersion` must equal `ENGINE_PLUGIN_API_VERSION`.
- `id` must be unique and match `^[a-z0-9]+(?:-[a-z0-9]+)*$` (example: `llama-cpp`).

## Required plugin metadata

- `displayName`: human-friendly name.
- `version`: plugin version.
- `capabilities`: supported features.

## Required lifecycle (in order)

1. `validateEnvironment()`
2. `validateRunConfig(runConfig)`
3. `buildLaunchConfig(runConfig)`
4. `start(context)`
5. `waitUntilReady(context)`
6. `executeCase(context, caseConfig)`
7. `collectMetrics(context)`
8. `stop(context)`

## Run config validation

- Plugin owns validation + normalization of:
  - `model.identifier`
  - `engine.serverArgs` (launch flags)
  - `engine.requestParams` (request payload params)
- `validationMode`:
  - `strict` (default): reject unknown flags/params.
  - `permissive`: allow unknown flags/params for experimentation.
- Reserved/denylisted flags/params are rejected in all modes.
- Prefer capability checks over version caps.

## Config boundaries

- Core owns generic benchmark config; plugin owns mapping to launches/requests.
- Preserve raw pass-through so new engine flags do not require core changes:
  - `engine.serverArgs: string[]`
  - `engine.requestParams: Record<string, unknown>`

## Launch safety

- Plugins must not install, download, build, or upgrade engine software.
- `EngineLaunchConfig.environmentOverrides` must not include unsafe injection keys (`LD_PRELOAD`, `LD_AUDIT`, `NODE_OPTIONS`, `DYLD_*`). No bypass.

## Errors + diagnostics

- For expected failures, throw an error with `code` + safe `message` (+ optional `details`).
- Use `ENGINE_*` codes for fatal engine failures.
- Treat subprocess output as untrusted; sanitize + bound excerpts; redact secrets (for example API keys) from args and logs.
