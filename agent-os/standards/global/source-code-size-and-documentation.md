# Source Code Size and Documentation

Keep implementation files small enough to reason about and document complex modules with concise, high-signal comments.

## Size budgets (SLOC)

- Enforce budgets by source lines of code (SLOC): non-empty lines excluding comment-only lines.
- Default budgets:
  - `src/**/*.ts`: at most 450 SLOC
  - `tests/**/*.ts`: at most 700 SLOC
- Existing oversized files may use ratcheted legacy caps in `scripts/check-source-quality.ts`:
  - Do not increase the SLOC cap for legacy files.
  - Reduce legacy files over time; each reduction should lower future headroom.

## Documentation requirements

- `src/**/*.ts` files at or above 200 SLOC must start with a module-level `/** ... */` doc block.
- Module docs should explain:
  - primary responsibility,
  - key invariants or safety constraints,
  - why this module exists when non-obvious.
- Inline comments should explain intent, constraints, and trade-offs, not restate obvious code.

## Refactoring guidance for large files

- Prefer extracting cohesive helpers/types into neighboring modules over adding more branches to already-large files.
- Split route files by endpoint concerns when one file accumulates unrelated handlers.
- Split orchestration modules by lifecycle phase (validation, startup, execution, teardown) when complexity grows.
- Keep behavior and tests in sync as files are split; avoid changing external contracts during pure refactors.

## Verification

- Run `bun run quality:check` locally before review.
- CI enforcement is through `bun run lint`, which includes this quality check.
