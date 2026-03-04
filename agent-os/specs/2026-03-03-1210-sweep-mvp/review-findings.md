# Review Findings and Decisions (2026-03-04)

This note records post-implementation review findings for Sweep MVP Tasks 1-2,
the decision taken for each finding, and where implementation landed.

## Decisions

1. **`totalCases` semantics with sweep**
   - Decision (updated after PR comment triage): temporarily reject all valid
     sweep run creation requests with `VALIDATION_SWEEP_NOT_SUPPORTED` until
     Task 3 (deterministic expansion/case IDs) and Task 4 (sweep execution)
     are implemented.
   - Rationale: avoid claiming `totalCases = plannedCases` before orchestrator
     execution actually iterates expanded sweep cases.
   - Removal requirement: Tasks 3/4 must explicitly remove this temporary gate
     and re-enable sweep acceptance only once execution parity is complete.
   - Implemented in: `src/server/routes/run-routes/index.ts`

2. **`requestParam` vs `requestParams` typo claim**
   - Decision: no change; false positive. Current code already uses
     `requestParams` consistently.
   - Verified in: `src/server/api/schemas.ts`

3. **JSON-only recursion guardrails**
   - Decision: add explicit depth and node-budget guards to sweep JSON-only
     validation to prevent stack/CPU abuse.
   - Implemented in: `src/server/runs/sweep-validation/json-only.ts`

4. **Schema-level sweep size limits**
   - Decision: add schema caps for axis count and axis value list sizes to fail
     oversized payloads early.
   - Implemented in: `src/server/api/schemas.ts`

5. **Sweep numeric constraints**
   - Decision: require integer + positive `repetitions`/`maxCases` at schema
     level. Keep the server ceiling (`MAX_SWEEP_CASES`) enforced in sweep
     validation so `VALIDATION_SWEEP_TOO_LARGE` behavior remains explicit.
   - Implemented in: `src/server/api/schemas.ts`,
     `src/server/runs/sweep-validation/index.ts`

6. **`cloneUnknown` fallback aliasing risk**
   - Decision: replace silent alias fallback with JSON clone fallback and a
     clear error if cloning is impossible.
   - Implemented in: `src/server/api/schemas.ts`

7. **Combined base+sweep argv ceiling**
   - Decision: validate the maximum possible merged argv length
     (`engine.serverArgs` + longest fragment per sweep axis) against server
     limits.
   - Implemented in: `src/server/runs/sweep-validation/index.ts`,
     `src/server/routes/run-routes/index.ts`

8. **Fast-fail on `sweep.maxCases > MAX_SWEEP_CASES`**
   - Decision: keep fast-fail behavior and document it as intentional to return
     an immediate, stable `VALIDATION_SWEEP_TOO_LARGE` error.
   - Documented in: `agent-os/specs/2026-03-03-1210-sweep-mvp/plan.md`

9. **Planned-case overflow hardening**
   - Decision: use bounded multiplication with early limit checks to avoid
     overflow while computing planned cases.
   - Implemented in: `src/server/runs/sweep-validation/index.ts`

10. **Redundant safe-integer check claim**
     - Decision: no change; false positive after verification.
     - Verified in: `src/server/runs/sweep-validation/index.ts`

11. **Sweep test coverage gaps**
    - Decision (updated): align tests with temporary sweep rejection while
      preserving pre-gate sweep validation assertions.
    - Implemented in: `tests/app-runs/sweep-validation.ts`

12. **Sweep fragment token count cap**
    - Decision: cap per-fragment token count to the same ceiling as base
      `engine.serverArgs` for consistency.
    - Implemented in: `src/server/api/schemas.ts`

13. **PR #21 comment: sweep/error message context**
    - Decision: rewrite request-param budget validation messages when surfaced
      through sweep validation so they reference
      `sweep.axes.requestParams.<key>[<index>]` instead of `engine.requestParams`.
    - Implemented in: `src/server/runs/sweep-validation/index.ts`

## Tasks 3-4 Review Findings and Decisions (2026-03-04)

This section captures follow-up review findings after Tasks 3-4 implementation,
the chosen disposition for each item, and whether it was implemented now or
deferred.

1. **Finally-block error masking in sweep case cleanup (H1)**
   - Decision: implement now.
   - Action: preserve primary cancellation/timeout failure when case-level
     cleanup stop fails; log cleanup stop failure instead of replacing the
     primary error.
   - Implemented in:
     `src/server/runs/run-orchestrator/sweep-execution/case-execution.ts`

2. **Sweep stop lifecycle guard parity with non-sweep path (H2)**
   - Decision: implement now.
   - Action: add `engineStopCompleted` semantics to sweep stop orchestration and
     avoid clearing active engine context on failed stop attempts.
   - Implemented in:
     `src/server/runs/run-orchestrator/sweep-execution/index.ts`

3. **Floating timeout stop call during start/readiness (H3)**
   - Decision: implement now.
   - Action: remove floating timeout stop calls from sweep case start/readiness
     timeout callbacks and rely on deterministic awaited cleanup in the case
     `finally` path.
   - Implemented in:
     `src/server/runs/run-orchestrator/sweep-execution/case-execution.ts`

4. **Defensive server-case cap during full expansion (M1)**
   - Decision: implement now as defense-in-depth.
   - Action: enforce a hard internal expansion ceiling (`MAX_SWEEP_CASES`) while
     materializing expanded cases.
   - Implemented in:
     `src/server/runs/sweep-expansion.ts`

5. **Run-level sweep metrics context (M2)**
   - Decision: implement now.
   - Action: include the associated case id alongside last-completed-case
     metrics at run level for sweep runs.
   - Implemented in:
     `src/server/runs/run-orchestrator/sweep-execution/index.ts`

6. **Silent JSON clone fallback mutation risk (M3)**
   - Decision: implement now.
   - Action: remove `JSON.stringify/parse` fallback in sweep clone helper and
     raise explicit canonicalization error when safe cloning fails.
   - Implemented in:
     `src/server/runs/sweep-expansion.ts`

7. **Consecutive lifecycle failure threshold coverage gap (M4)**
   - Decision: implement now.
   - Action: add test coverage for
     `MAX_CONSECUTIVE_ENGINE_LIFECYCLE_FAILURES = 3` behavior.
   - Implemented in:
     `tests/app-runs/sweep-execution.ts`

8. **Redundant `markRunRunning` in sweep fail helper (M5 + L1)**
   - Decision: implement now.
   - Action: call `markRunRunning` only for pre-run failure paths
     (`startIndex === 0`), removing redundant mid-run transition calls.
   - Implemented in:
     `src/server/runs/run-orchestrator/sweep-execution/failure-utils.ts`

9. **Potential cross-run `caseConfigId` collision concern (M6)**
   - Decision: no behavior change needed; document invariant.
   - Rationale: artifacts are persisted under run-scoped paths
     (`runs/<runId>/result.json`), so identical `caseConfigId` values across
     runs do not cause storage collisions.
   - Documented in: `src/server/runs/sweep-expansion.ts`

10. **Polling budget fragility in sweep tests (L2)**
    - Decision: implement now.
    - Action: increase default polling budget and make helper polling options
      configurable.
    - Implemented in: `tests/app-runs/helpers.ts`

11. **Missing sweep run-timeout regression coverage (L3)**
    - Decision: implement now.
    - Action: add test asserting sweep run timeout surfaces as
      `RUN_TIMEOUT_EXCEEDED`.
    - Implemented in: `tests/app-runs/sweep-execution.ts`

12. **Repetition indexing clarity (L4)**
    - Decision: document now (no behavior change).
    - Action: add explicit field doc that `repetitionIndex` is zero-based while
      caseId repetition suffixes are one-based.
    - Implemented in: `src/server/runs/sweep-expansion.ts`

13. **Canonicalization allocation optimization (L5)**
    - Decision: defer to a future spec (tracked, not lost).
    - Scope: consider streaming/incremental hashing to reduce peak string
      allocations when canonicalizing unusually large case config payloads.
    - Tracking: noted in this spec's `plan.md` future follow-up section.
