# Log Metrics Efficiency Analysis

## Objective

Extract deeper performance signals from engine logs and classify inefficient configurations.

## Context carried from shaping

- Log tapping is required because not all useful metrics are available in OpenAI-compatible API responses.
- Acceptance ratio is an important efficiency signal; low acceptance should be explicitly surfaced.
- This phase captures practical, high-value metrics first rather than complete methodology parity.
- Metric semantics must be explicit:
  - TTFT should refer to the first usable content token (not the first streamed chunk / first byte).
  - Prefix caching and warmup behavior can distort prompt-eval speed; surface confidence and caveats.

## Deliverables

- Structured log tapping pipeline (stdout/stderr capture + parsing stages).
- Metric extractors for prompt eval speed, TTFT, total latency, and speculative acceptance where available.
- Confidence/error reporting for parse coverage.
- Efficiency heuristics and flags (for example acceptance ratio thresholds).
- Inclusion of parsed metrics in run artifacts and exports.
- Optional (bounded) timeseries/coverage diagnostics under `metricsExtra` for deeper analysis when needed.

## Standards applied

- `agent-os/standards/plugins/engine-interface.md`
- `agent-os/standards/runs/result-schema.md`

## Reference implementations

- See `references.md`.

## Non-goals

- Building full statistical modeling or anomaly detection systems.
- Supporting every engine's log format in this phase.

## Prerequisites / inputs

- v0.1.0 `workload-packs-and-exports` should persist bounded engine logs as run artifacts:
  - `runs/{runId}/engine.stdout.log`
  - `runs/{runId}/engine.stderr.log`
  - and list them in `runs/{runId}/manifest.json` when present.
- If logs are unavailable for an engine/target, parsing should degrade gracefully (null metrics + reasons).

## Implementation tasks

1. Ensure log artifacts are available and addressable.
   - Confirm engine log artifacts exist (or are intentionally absent with a reason) for runs:
     - `engine.stdout.log`
     - `engine.stderr.log`
   - Ensure the artifact manifest/index exposes log URLs so the parser can fetch inputs via filesystem or API.
   - Manual testing steps:
     - Complete a run and confirm logs exist (or are absent with a documented reason).
     - Verify `runs/RUN_ID/manifest.json` includes log entries when present.

2. Define metric event model and parser interfaces.
   - Define a typed internal model for captured engine output:
     - timestamped `stdout`/`stderr` line events
     - optional structured markers (when available)
   - Define parser interfaces:
     - `parseLogs(events) -> { metrics, confidence, errors, excerpts }`
     - Keep parsing pure (no filesystem/network).
   - Define a standard way to attach parse results to cases:
     - fill result-schema fields (`ttftMs`, `promptEvalTokensPerSecond`, `acceptanceRatio`) when extracted
     - include additional fields under `metricsExtra` when needed
   - Manual testing steps:
     - Run unit tests that feed known log lines and assert parsed outputs.

3. Implement `llama.cpp` parser rules and fallback behavior.
   - Inputs:
     - `llama-server` stdout/stderr captured during case execution.
   - Extract (best-effort):
     - `ttftMs`
     - `promptEvalTokensPerSecond`
     - `acceptanceRatio` (when speculative decoding logs expose it)
   - Fallback behavior:
     - If parsing fails for a metric: keep the run alive and set the metric field to `null`.
     - Record a bounded raw excerpt and a reason (e.g., "pattern_not_found", "format_changed").
   - Record parse coverage:
     - Persist a per-run coverage summary under `metricsExtra.parseCoverage`.
     - Persist per-case parse reasons for null metrics.
   - Manual testing steps:
     - Run a benchmark and inspect `runs/RUN_ID/result.json` for non-null deep metrics.
     - Modify logs/fixtures to force a parse miss and verify metrics become `null` with a reason.

4. Add efficiency scoring and threshold flags.
   - Compute lightweight heuristics:
     - flag low `acceptanceRatio` configurations (configurable threshold)
     - flag unusually low throughput or high latency relative to the run median
   - Persist as:
     - per-case flags under `metricsExtra.flags`
     - run-level summary aggregates under `result.json.summary`
   - Manual testing steps:
     - Run a sweep with varying parameters and verify flagged cases appear in `summary.md`.

5. Integrate parsed metrics into `result.json`, CSV, and summary markdown.
   - Ensure `result.json` fills result-schema deep metric fields where available.
   - Ensure exporters include these fields and remain stable:
     - CSV: `ttft_ms`, `prompt_eval_tokens_per_second`, `acceptance_ratio`, plus `metrics_extra_json`.
     - Markdown: include a deep-metrics section and parse coverage summary.
   - Manual testing steps:
     - Complete a run and verify:
       - `runs/RUN_ID/result.json` has deep metric fields
       - `runs/RUN_ID/cases.csv` includes deep metric columns
       - `runs/RUN_ID/summary.md` includes parse coverage notes

6. Add parser tests with real log fixtures.
   - Capture representative `llama.cpp` logs into fixtures.
   - Add golden tests for the parser output and for exporter output stability.
   - Manual testing steps:
     - Run tests: `bun test`

## Exit criteria

- Sweep outputs include reliable deep metrics and clearly flag inefficient parameter regions.

## Dependencies

- Requires `server-plugin-llama-cpp-foundation`, `workload-packs-and-exports`, and `sweep-engine-run-orchestration`.
