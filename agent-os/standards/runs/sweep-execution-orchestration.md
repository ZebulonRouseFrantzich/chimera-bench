# Sweep Execution Orchestration

Run sweep cases sequentially with restart-per-case and bounded infra-failure policy.

## Case lifecycle

For each expanded sweep case, run in order:

1. `buildLaunchConfig`
2. `start`
3. `waitUntilReady`
4. `executeCase`
5. `collectMetrics` (best effort)
6. `stop`

## Failure policy

- Per-case validation/execution failures record `run.case.failed` and continue.
- Engine lifecycle failures are counted when `start`/`waitUntilReady`/required lifecycle transport fails.
- Do not count pure per-case validation failures as lifecycle failures.
- Stop condition (v0.0.1): `MAX_CONSECUTIVE_ENGINE_LIFECYCLE_FAILURES = 3`.
- When threshold is hit, fail run and mark remaining sweep cases failed.

## Timeout and cancellation

- Orchestrator owns run and case timeouts.
- Cancellation aborts active work, requests engine stop, and transitions run to `cancelled`.
- Always persist terminal `result.json` for `completed`/`failed`/`cancelled`.

## Latency semantics

- Sweep per-case `latencyMs` measures `executeCase()` time only.
- Startup/readiness time is excluded from per-case latency.

## Cleanup correctness

- Always attempt case-level stop in `finally`.
- If stop fails after a primary timeout/cancel/failure already occurred, keep primary failure and log stop failure (do not mask root cause).
- Stop calls must be deduplicated so concurrent stop paths share one in-flight stop promise.
