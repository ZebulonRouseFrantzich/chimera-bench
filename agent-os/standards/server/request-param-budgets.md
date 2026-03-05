# Request Param Budgets

Apply bounded request-param budgets to prevent oversized/deep payload abuse.

## Base `engine.requestParams` limits

- max top-level keys: `128`
- max key length: `128`
- max nested depth: `8`
- max traversed nodes: `512`
- max string length: `8192`

## Validation behavior

- Enforce budgets during request schema validation.
- Report actionable validation issues with explicit paths.
- Keep limits deterministic and environment-independent.

## Sweep parity

- Apply the same depth/node/string/key budgets to each `sweep.axes.requestParams.<key>[<index>]` value.
- Run sweep JSON-only checks first, then budget checks.
- Surface sweep budget failures at sweep paths (not `engine.requestParams` paths).
