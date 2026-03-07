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

## Optional reproducibility fields (recommended)

These fields are optional and additive. They improve reproducibility and cross-run comparability.

- `workloadPack` (object)
  - For workload packs (built-in or filesystem), persist:
    - `schemaVersion`
    - `version`
    - `source` (`built-in` | `filesystem`)
    - `digestSha256`
    - `contextDigests` (array of `{ path, sha256, bytes }`)
  - Do not persist absolute filesystem paths.

- `modelInfo` (object)
  - When the orchestrator can access model bytes locally, persist:
    - `resolvedPath` (optional)
    - `bytes` (nullable)
    - `mtimeMs` (nullable)
    - `digestSha256` (nullable)
  - When the model refers to a remote path, set digest fields to `null` and include `unavailableReason`.

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

Additional artifacts (derive from `result.json` when applicable; may be absent depending on server version/config):

- `runs/{runId}/manifest.json`
- `runs/{runId}/cases.csv`
- `runs/{runId}/cases.ndjson`
- `runs/{runId}/summary.md`
- `runs/{runId}/bundle.tgz`
- `runs/{runId}/engine.stdout.log` (optional; bounded + redacted)
- `runs/{runId}/engine.stderr.log` (optional; bounded + redacted)
