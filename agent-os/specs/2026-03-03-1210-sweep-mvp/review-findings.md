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

## SSH Sweep Shutdown Follow-up Findings (2026-03-04)

This section tracks post-merge hardening work for SSH-managed sweep cleanup and
maps each review finding to the implemented disposition.

1. **Cleanup `pkill -f` pattern precision**
   - Decision: implement now.
   - Action: harden cleanup pattern matching by anchoring to `llama-server`
     command boundaries, escaping regex literals (including loopback host), and
     requiring run-unique `--api-key` + `--no-webui` markers in the match.
   - Implemented in:
     `src/server/engines/starter-engine/run-state.ts`

2. **`exitCode ?? 0` null-coalescing in cleanup**
   - Decision: implement now.
   - Action: treat `exitCode: null` (or signal-only termination) as an
     indeterminate cleanup result rather than success.
   - Implemented in:
     `src/server/engines/starter-engine/run-state.ts`

3. **Unconditional SIGKILL shortly after TERM**
   - Decision: implement now.
   - Action: replace TERM->fixed-KILL flow with TERM->grace->`pgrep` liveness
     check->conditional KILL.
   - Implemented in:
     `src/server/engines/starter-engine/run-state.ts`

4. **Duplicate remote port state across fields**
   - Decision: implement now.
   - Action: remove duplicate `remotePort` from `sshManagedRuntime`; keep
     remote port authority in `remotePortReservation` and derive cleanup port
     from that reservation.
   - Implemented in:
     `src/server/engines/starter-engine/types.ts`,
     `src/server/engines/starter-engine/startup.ts`,
     `src/server/engines/starter-engine/run-state.ts`

5. **Cleanup test coverage gaps**
   - Decision: implement now.
   - Action: add tests for remote cleanup throw handling, TERM non-match skip,
     and missing SSH runtime metadata.
   - Implemented in:
     `tests/starter-engine/lifecycle-and-ssh.ts`,
     `tests/starter-engine/run-state.ts`

6. **Signal naming consistency (`TERM` vs `SIGTERM`)**
   - Decision: implement now.
   - Action: standardize internal signal names (`SIGTERM` / `SIGKILL`) and map
     explicitly to `pkill` CLI flags (`-TERM` / `-KILL`).
   - Implemented in:
     `src/server/engines/starter-engine/run-state.ts`

7. **Potential duplicate cleanup on repeated stop calls**
   - Decision: implement now.
   - Action: add idempotent stop lifecycle guards (`stopPromise` +
     `stopCompleted`) so concurrent stop calls share one cleanup sequence.
   - Implemented in:
     `src/server/engines/starter-engine/types.ts`,
     `src/server/engines/starter-engine/run-state.ts`,
     `tests/starter-engine/run-state.ts`

8. **Hardcoded remote cleanup timing values**
   - Decision: implement now.
   - Action: add dependency-level tuning knobs for remote cleanup command
     timeout and grace period, with safe defaults from constants.
   - Implemented in:
     `src/server/engines/starter-engine/constants.ts`,
     `src/server/engines/starter-engine/types.ts`,
     `src/server/engines/starter-engine/dependencies.ts`,
     `src/server/engines/starter-engine/run-state.ts`

9. **Shutdown latency tradeoff documentation**
   - Decision: document now.
   - Action: add inline code documentation for bounded worst-case SSH cleanup
     latency and rationale (prefer leak prevention over fastest shutdown).
   - Documented in:
      `src/server/engines/starter-engine/run-state.ts`

10. **POSIX regex portability for `pkill -f` / `pgrep -f` whitespace matching**
    - Decision: implement now.
    - Severity: High.
    - Action: replace non-portable `\\s` tokens in cleanup regex patterns with
      POSIX ERE-safe whitespace class (`[[:space:]]`) and add explicit test
      coverage that the generated cleanup pattern includes the POSIX class.
    - Implemented in:
      `src/server/engines/starter-engine/run-state/remote-cleanup.ts`,
      `tests/starter-engine/lifecycle-and-ssh.ts`

## PR #22 Comment Assessment (2026-03-05)

Assessment of all PR comments for
`https://github.com/ZebulonRouseFrantzich/chimera-bench/pull/22`.

1. **Review summary comment**
   - Source:
     `https://github.com/ZebulonRouseFrantzich/chimera-bench/pull/22#pullrequestreview-3892669944`
   - Severity: Low.
   - Opinion: informational summary only; no actionable defect.
   - Decision: no code change.

2. **Review wrapper comment**
   - Source:
     `https://github.com/ZebulonRouseFrantzich/chimera-bench/pull/22#pullrequestreview-3892975248`
   - Severity: Low.
   - Opinion: informational wrapper only; actionable content is in inline
     review comments.
   - Decision: no code change.

3. **Inline portability comment on regex whitespace token**
   - Source:
      `https://github.com/ZebulonRouseFrantzich/chimera-bench/pull/22#discussion_r2886994651`
   - Severity: High.
   - Opinion: valid portability/correctness risk for POSIX ERE matching in
     `pkill`/`pgrep` cleanup paths.
   - Decision: implement now.
   - Implemented in:
      `src/server/engines/starter-engine/run-state/remote-cleanup.ts`,
      `tests/starter-engine/lifecycle-and-ssh.ts`

## Task 5 Review Findings and Decisions (2026-03-05)

Assessment of Task 5 uncommitted changes after dual-model review. This section
captures the final disposition for each finding and maps accepted items to
implementation.

1. **M1: duplicated `cloneUnknown` utility**
   - Decision: implement now.
   - Action: centralize sweep value cloning for run-store sweep modules.
   - Implemented in:
     `src/server/runs/in-memory-run-store/sweep-config.ts`,
     `src/server/runs/in-memory-run-store/results.ts`

2. **M2: duplicated sweep-axis clone logic**
   - Decision: implement now.
   - Action: extract shared `cloneSweepAxes` helper and reuse it for both
     stored config cloning and persisted result shaping.
   - Implemented in:
     `src/server/runs/in-memory-run-store/sweep-config.ts`,
     `src/server/runs/in-memory-run-store/results.ts`

3. **M3: deterministic ranking assumes pre-rounded floats**
   - Decision: implement now (hardening).
   - Action: normalize `tokensPerSecond` to 3 decimals at ranking comparison
     time and document this deterministic-contract guardrail inline.
   - Implemented in:
     `src/server/runs/in-memory-run-store/results.ts`

4. **M4: silent clone-fallback data-shape risk**
   - Decision: implement now.
   - Action: remove JSON stringify/parse fallback in sweep run-store cloning;
     raise explicit error when sweep value cloning fails.
   - Implemented in:
     `src/server/runs/in-memory-run-store/sweep-config.ts`

5. **L1: ranking type repeated inline**
   - Decision: implement now.
   - Action: add named sweep ranking/result type aliases and consume them in
     result builders.
   - Implemented in:
     `src/server/runs/in-memory-run-store/types.ts`,
     `src/server/runs/in-memory-run-store/results.ts`

6. **L2: `request.sweep` spread may leak future fields**
   - Decision: implement now.
   - Action: replace spread with explicit field mapping to the stored sweep
     shape before queuing runs.
   - Implemented in:
     `src/server/routes/run-routes/index.ts`

7. **L3: missing empty-ranking edge-case coverage**
   - Decision: implement now.
   - Action: add unit test asserting sweep ranking is an empty array when no
     case outcomes were recorded.
   - Implemented in:
     `tests/in-memory-run-store.test.ts`

8. **L4: integration cast lacks runtime guard**
   - Decision: implement now.
   - Action: add explicit assertion that `result.sweep` exists before typed
     narrowing in ranking integration coverage.
   - Implemented in:
     `tests/app-runs/sweep-execution.ts`

9. **L5: manual lexicographic comparator vs `localeCompare`**
   - Decision: no code change.
   - Rationale: `caseId` is ASCII-constrained and deterministic ordering is
     intentionally locale-independent.

10. **L6: rank starts at `1`**
    - Decision: no code change.
    - Rationale: this is intentional and aligned with Task 5 artifact examples
      and ranking semantics.

11. **Manual validation: all-zero TPS due to stubbed `executeCase()`**
    - Severity: Medium.
    - Opinion: valid gap; ranking inputs become latency-only when outputs are
      stubbed.
    - Decision: add Task 6 to this spec to implement real
      `/v1/chat/completions` execution and produce non-stubbed throughput
      metrics.
    - Tracked in: `agent-os/specs/2026-03-03-1210-sweep-mvp/plan.md`

## Task 6 Implementation Notes (2026-03-05)

1. **llama-server case execution is now wired to real chat-completions calls**
   - Action: replace the `executeCase()` placeholder with a real
     `POST /v1/chat/completions` request path using per-run bearer auth,
     non-streaming responses, and structured output extraction.
   - Implemented in:
     `src/server/engines/starter-engine/case-execution.ts`,
     `src/server/engines/starter-engine/index.ts`,
     `src/server/engines/starter-engine/utils.ts`

2. **Sweep latency semantics align to inference time**
   - Action: measure sweep `latencyMs` from `executeCase()` wall time rather
     than including start/readiness lifecycle overhead.
   - Implemented in:
     `src/server/runs/run-orchestrator/sweep-execution/case-execution.ts`

3. **Task 6 regression coverage**
   - Action: add starter-engine tests for successful execution request wiring,
     non-2xx handling, and invalid-JSON handling; add sweep latency regression
     coverage that guards against restart-time inflation.
   - Implemented in:
      `tests/starter-engine/case-execution.ts`,
      `tests/app-runs/sweep-execution.ts`

## Task 6 Post-Review Findings and Decisions (2026-03-05)

This section captures follow-up review findings on Task 6 and the disposition
implemented for each item.

1. **H1: unbounded response body read risk**
   - Decision: implement now.
   - Action: replace unbounded `response.text()` usage with bounded stream reads
     plus `content-length` precheck; fail with `ENGINE_EXECUTION_FAILED` when
     size limits are exceeded.
   - Implemented in:
     `src/server/engines/starter-engine/case-execution.ts`,
     `src/server/engines/starter-engine/constants.ts`,
     `src/server/engines/starter-engine/types.ts`,
     `src/server/engines/starter-engine/dependencies.ts`

2. **H2: reserved request-param defense-in-depth**
   - Decision: implement now.
   - Action: strip reserved request-param keys before dispatching runtime
     `/v1/chat/completions` payloads, even when upstream validation is expected
     to reject them.
   - Implemented in:
     `src/server/engines/starter-engine/case-execution.ts`

3. **H3: diagnostic response excerpt exposure**
   - Decision: implement now.
   - Action: keep warn-level diagnostics metadata-focused (status/size/reason)
     and stop emitting response-body excerpts by default for case execution
     failures.
   - Implemented in:
     `src/server/engines/starter-engine/case-execution.ts`

4. **M1: latency regression test flakiness risk**
   - Decision: implement now.
   - Action: increase latency test timing margins so it remains reliable under
     slower CI schedulers while still proving execute-time latency semantics.
   - Implemented in:
     `tests/app-runs/sweep-execution.ts`

5. **M2: executeCase success test lifecycle realism**
   - Decision: implement now.
   - Action: require `waitUntilReady()` in success-path execution coverage.
   - Implemented in:
     `tests/starter-engine/case-execution.ts`

6. **M3: `isRecord` array acceptance**
   - Decision: implement now.
   - Action: tighten object guard to reject arrays.
   - Implemented in:
     `src/server/engines/starter-engine/case-execution.ts`

7. **M4: `latencyMs: 0` intent clarity for pre-exec failures**
   - Decision: implement now (documentation-only).
   - Action: add inline comments clarifying intentional zero latency when case
     validation fails before `executeCase()` starts.
   - Implemented in:
     `src/server/runs/run-orchestrator/sweep-execution/case-execution.ts`

8. **M5: pre-parse response size guard**
   - Decision: implement now.
   - Action: enforce explicit size guard before JSON parse as part of bounded
     response read handling.
   - Implemented in:
     `src/server/engines/starter-engine/case-execution.ts`

9. **L1: missing fetch-throw/abort coverage**
   - Decision: implement now.
   - Action: add tests for network throw (`ENGINE_EXECUTION_FAILED`) and
     AbortError passthrough behavior.
   - Implemented in:
     `tests/starter-engine/case-execution.ts`

10. **L2: missing assistant-output-shape coverage**
    - Decision: implement now.
    - Action: add test for valid JSON with missing assistant output structure.
    - Implemented in:
      `tests/starter-engine/case-execution.ts`

11. **L3: URL query/hash stripping rationale clarity**
    - Decision: implement now (documentation-only).
    - Action: add inline comment that query/hash stripping is intentional for
      stable request shaping.
    - Implemented in:
      `src/server/engines/starter-engine/utils.ts`

12. **L4: assistant role handling strictness**
    - Decision: implement now.
    - Action: prefer `message.role === "assistant"` content when role is
      present, while keeping fallback compatibility behavior.
    - Implemented in:
      `src/server/engines/starter-engine/case-execution.ts`

13. **L5: duplicated latency calculation clarity**
    - Decision: implement now.
    - Action: centralize latency computation in a helper used by both success
      and failure paths.
    - Implemented in:
      `src/server/runs/run-orchestrator/sweep-execution/case-execution.ts`

14. **Manual SSH sweep validation: repeated HTTP 400 on case execution**
    - Severity: High.
    - Opinion: valid runtime compatibility issue; some OpenAI-compatible
      backends require `model` in chat-completions request bodies even when a
      single model is preloaded by server startup args.
    - Decision: implement now.
    - Action: set `model` in runtime case request payloads from the core-owned
      run-state model identifier while keeping user-provided reserved-key
      stripping in place.
    - Implemented in:
      `src/server/engines/starter-engine/case-execution.ts`,
      `src/server/engines/starter-engine/types.ts`,
      `src/server/engines/starter-engine/startup.ts`,
      `src/server/engines/starter-engine/index.ts`,
      `tests/starter-engine/case-execution.ts`

15. **Manual SSH sweep validation: context-overflow HTTP 400 for tuning prompt**
    - Severity: High.
    - Opinion: valid correctness/UX gap; sweep cases should fail with an
      explicit prompt-vs-context-size error rather than opaque downstream 400s
      after launch/readiness.
    - Decision: implement now.
    - Action: add per-case prompt token preflight using `/tokenize` and compare
      against configured `--ctx-size` with a conservative chat-overhead buffer;
      fail early with `VALIDATION_PROMPT_TOO_LARGE` when oversized.
    - Implemented in:
      `src/server/engines/starter-engine/prompt-fit-preflight.ts`,
      `src/server/engines/starter-engine/case-execution.ts`,
      `src/server/engines/starter-engine/http-response-limit.ts`,
      `src/server/engines/starter-engine/types.ts`,
      `src/server/engines/starter-engine/startup.ts`,
      `src/server/engines/starter-engine/index.ts`,
      `tests/starter-engine/case-execution.ts`

16. **Scenario-style prompt selection and calibration policy**
    - Severity: Low.
    - Opinion: valuable for operator ergonomics, but out of scope for v0.0.1.
    - Decision: defer.
    - Rationale: v0.0.1 ships explicit prompt-fit failures (`VALIDATION_PROMPT_TOO_LARGE`) to
      prevent opaque repeated sweep failures; richer prompt packs / scenarios / calibration
      modes belong in the workload pack surface.
    - Tracked in: `agent-os/specs/2026-02-23-1716-workload-packs-and-exports/`

## Task 6 Dual-Review Follow-up (2026-03-05, round 2)

1. **H1: unsanitized rawResponse persistence**
   - Decision: implement now.
   - Action: persist an allowlisted chat-completions response projection rather
     than full upstream payload passthrough.
   - Implemented in:
     `src/server/engines/starter-engine/chat-completions-response.ts`,
     `src/server/engines/starter-engine/case-execution.ts`,
     `tests/starter-engine/case-execution.ts`,
     `tests/starter-engine/chat-completions-response.ts`

2. **H2: prompt preflight skipped when `--ctx-size` is absent**
   - Decision: implement now.
   - Action: emit one-time per-run diagnostic when preflight is skipped and add
     fallback mapping of upstream context-overflow HTTP errors to
     `VALIDATION_PROMPT_TOO_LARGE`.
   - Implemented in:
     `src/server/engines/starter-engine/prompt-fit-preflight.ts`,
     `src/server/engines/starter-engine/case-execution.ts`,
     `src/server/engines/starter-engine/chat-completions-response.ts`,
     `tests/starter-engine/case-execution.ts`,
     `tests/starter-engine/chat-completions-response.ts`

3. **H3: temporary memory overhead in bounded response reads**
   - Decision: implement now.
   - Action: replace chunk-by-chunk string buffering with bounded byte
     accumulation + single decode pass.
   - Implemented in:
     `src/server/engines/starter-engine/http-response-limit.ts`,
     `tests/starter-engine/http-response-limit.ts`

4. **M1: redundant post-read size check**
   - Decision: implement now.
   - Action: remove dead post-read guard after bounded reader already enforces
     size limits.
   - Implemented in:
     `src/server/engines/starter-engine/case-execution.ts`

5. **M2: output token count quality**
   - Decision: implement now.
   - Action: prefer `usage.completion_tokens` for completed cases when present,
     with existing text-estimation fallback.
   - Implemented in:
     `src/server/runs/in-memory-run-store/case-outcomes.ts`,
     `tests/in-memory-run-store.test.ts`

6. **M3: throughput metric semantics clarity**
   - Decision: implement now (documentation-only).
   - Action: document that v0.0.1 TPS remains end-to-end latency based.
   - Implemented in:
     `src/server/runs/in-memory-run-store/case-outcomes.ts`,
     `agent-os/specs/2026-03-03-1210-sweep-mvp/shape.md`

7. **M4: advisory nature of Content-Length precheck**
   - Decision: implement now (documentation-only).
   - Action: add inline comment clarifying header precheck is optimization-only;
     streaming byte accounting is authoritative.
   - Implemented in:
     `src/server/engines/starter-engine/http-response-limit.ts`

8. **M5: per-fetch timeout gap**
   - Decision: no code change (v0.0.1).
   - Rationale: orchestrator case/run timeouts already bound execution and
     abort in-flight work. Engine-local fetch timeout knobs are deferred.

9. **L1: duplicated helper guards**
   - Decision: implement now.
   - Action: consolidate `isRecord` / `isAbortError` into shared starter-engine
     utils and reuse across case-execution + prompt preflight.
   - Implemented in:
     `src/server/engines/starter-engine/utils.ts`,
     `src/server/engines/starter-engine/case-execution.ts`,
     `src/server/engines/starter-engine/prompt-fit-preflight.ts`

10. **L2: multipart content join semantics**
    - Decision: implement now (documentation-only).
    - Action: add explicit inline comment explaining separator-free join behavior.
    - Implemented in:
      `src/server/engines/starter-engine/case-execution.ts`

11. **L3: dedicated module-level test coverage**
    - Decision: implement now.
    - Action: add focused tests for response shaping, bounded reader behavior,
      and utility flag parsing semantics.
    - Implemented in:
      `tests/starter-engine/chat-completions-response.ts`,
      `tests/starter-engine/http-response-limit.ts`,
      `tests/starter-engine/utils.ts`,
      `tests/starter-engine/index.ts`

12. **L4: duplicate-flag parsing order**
    - Decision: implement now.
    - Action: use last-occurrence semantics for flag value extraction to match
      effective CLI behavior.
    - Implemented in:
      `src/server/engines/starter-engine/utils.ts`,
      `tests/starter-engine/utils.ts`

13. **L5: fixed prompt-overhead constant rationale**
    - Decision: no behavioral change (v0.0.1), clarify intent.
    - Action: document conservative-overhead rationale inline and in spec notes.
    - Implemented in:
      `src/server/engines/starter-engine/prompt-fit-preflight.ts`,
      `agent-os/specs/2026-03-03-1210-sweep-mvp/plan.md`
