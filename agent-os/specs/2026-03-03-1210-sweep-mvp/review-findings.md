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
