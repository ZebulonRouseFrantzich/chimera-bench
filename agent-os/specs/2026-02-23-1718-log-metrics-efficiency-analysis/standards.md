# Standards for Log Metrics Efficiency Analysis

This file embeds the full text of the standards referenced by `plan.md` so this spec can be reviewed in isolation.

---

## Source: `agent-os/standards/plugins/engine-interface.md`

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

## Validation expectations

- `validateEnvironment()` verifies required external tooling is present and runnable (for example `llama-server`).
- Plugins must not install, download, build, or upgrade engine software; they only detect + validate + report actionable errors.
- Prefer capability checks over version caps (i.e. verify the specific flags/endpoints/features needed for the requested run).
- Plugins validate engine-specific inputs before execution:
  - `engine.serverArgs` (launch flags)
  - `engine.requestParams` (request payload params)
  - Unknown args/params should be rejected by default; allow an explicit opt-in permissive mode for experimentation.
- Core owns generic benchmark config (`model`, `workload`, `sweep`, `target`); plugins own how those map onto engine launches and requests.

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

---

## Source: `agent-os/standards/runs/result-schema.md`

# Run Result Schema

Persist benchmark data as JSON first, then derive CSV and markdown exports from JSON.

## Required top-level run fields

- `schemaVersion`
- `runId`
- `createdAt`
- `orchestratorVersion`
- `engineId`
- `engineVersion`
- `target` (`local` or `ssh`)
- `model` (object with at least `identifier`)
- `workloadId`
- `status`
- `startedAt`
- `finishedAt`
- `durationMs`

## Required per-case fields

- `caseId`
- `runId`
- `index`
- `promptId`
- `contextTokens`
- `engineArgs`
- `requestParams`
- `status`
- `latencyMs`
- `ttftMs` (nullable; best-effort until deep log parsing is implemented)
- `outputTokens`
- `tokensPerSecond`
- `promptEvalTokensPerSecond` (nullable)
- `acceptanceRatio` (nullable)
- `error` (nullable)

## Units and naming

- Durations use milliseconds (`*Ms`).
- Throughput uses tokens per second.
- Ratios are decimal values in range `[0, 1]`.
- JSON keys use `camelCase`; CSV headers use `snake_case`.

## Extensibility

- Add optional metrics under `metricsExtra` (JSON object).
- Mirror that field in CSV as `metrics_extra_json`.
- Never remove required fields without bumping `schemaVersion`.

## Export artifacts

Each run must emit:

- `runs/{runId}/result.json`
- `runs/{runId}/cases.csv`
- `runs/{runId}/summary.md`
