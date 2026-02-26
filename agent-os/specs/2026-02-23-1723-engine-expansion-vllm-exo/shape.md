# Engine Expansion (vLLM and exo) - Shaping Notes

## Scope

- Add at least two additional engine plugins (`vLLM`, `exo`) under the shared engine interface.
- Preserve core orchestration and run schema stability.
- Document capability differences and known limitations.

## Decisions

- Prefer OpenAI-compatible HTTP surfaces when available (to reuse core case execution patterns).
- Keep strict-by-default validation with permissive opt-in.
- Bind engine servers to loopback by default; require auth for any non-loopback usage.
- Visuals: none.

## Assumptions

- Spec 1 engine plugin contract is stable.
- Spec 3 exports and Spec 5 deep metrics parsing exist (or metrics remain partially null).

## Risks

- Engine install/runtime dependencies vary widely; environment validation must be clear and actionable.
- Metric parity will be imperfect; schema must tolerate missing metrics.

## Success Criteria

- Users can run comparable workloads on `llama.cpp`, `vLLM`, and `exo` and retrieve consistent artifacts.
