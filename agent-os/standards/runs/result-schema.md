# Run Result Schema

Persist benchmark data as JSON first. CSV/markdown exports are derived from JSON when implemented.

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

## Conditional top-level fields

- `targetProfileId`
  - required when `target` is `ssh`
  - omitted (or `null`) when `target` is `local`
  - additive field; no schema version bump required for this addition

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

Required now:

- `runs/{runId}/result.json`

Deferred exports (derive from `result.json`; do not assume present yet):

- `runs/{runId}/cases.csv`
- `runs/{runId}/summary.md`
