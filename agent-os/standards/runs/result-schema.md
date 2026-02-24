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
- `ttftMs`
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
