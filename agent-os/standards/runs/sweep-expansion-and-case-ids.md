# Sweep Expansion and Case IDs

Expand sweep axes deterministically so identical input yields identical case order and IDs.

## Expansion order

- Namespace order is fixed: `axes.serverArgs` then `axes.requestParams`.
- Axis keys are sorted lexicographically in each namespace.
- Axis value list order is preserved as provided.
- Expand cartesian product, then apply `repetitions`.
- Enforce internal expansion ceiling: never materialize more than `MAX_SWEEP_CASES`.

## Case identity

- `caseConfigId = "sweep_" + sha256(canonicalJson(caseConfigWithoutRepetition))`
- `caseId = caseConfigId + ".rep-" + (repetitionIndex + 1)`
- `repetitionIndex` is zero-based; `.rep-*` suffix is one-based.

Canonical payload fields:

- `engineId`
- `modelIdentifier`
- `workloadId`
- `promptId`
- `engineArgs`
- `requestParams`

## Canonical JSON rules

- Allow only JSON values (`null`, booleans, strings, finite numbers, arrays, plain objects).
- Reject `undefined`, non-finite numbers, `BigInt`, symbols, functions, non-plain objects, and circular references.
- Sort object keys lexicographically at every level.
- Preserve array order.

## Identity scope

- `caseConfigId` intentionally omits `runId`.
- Identical config across runs should map to the same config ID.
- Collision risk is managed by run-scoped artifact paths (`runs/{runId}/...`).
