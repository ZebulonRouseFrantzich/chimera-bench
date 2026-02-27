# AGENTS.md

Guidance for coding agents working in `chimera-bench`.
This repository is a Bun + TypeScript server/CLI project.
Keep changes small, focused, and consistent with existing patterns.

## Project Snapshot
- Runtime: Bun (ESM mode)
- Language: TypeScript (`strict`)
- HTTP framework: Hono
- Test runner: `bun test`
- Task runner: `just`
- Optional environment: Nix flake + direnv

## Repository Layout
- `src/cli.ts`: top-level CLI entrypoint and exit-code mapping
- `src/cli/serve-command.ts`: `serve` argument parsing + startup/shutdown flow
- `src/server/`: app wiring, middleware, runtime lifecycle, config
- `tests/`: Bun tests (`*.test.ts`)
- `bin/chimera-bench`: executable entry script

## Build, Lint, and Test Commands
Prefer `just` wrappers for common tasks; use `bun` directly for targeted runs.

### Install
- `just install`
- Equivalent: `bun install`

### Lint / Typecheck
- `just lint`
- Equivalent: `bun run lint`
- Lint script today is typecheck: `bun run typecheck`
- Direct typecheck: `tsc --noEmit`

### Tests (full suite)
- `just test`
- Equivalent: `bun run test`
- Direct: `bun test`

### Tests (single file)
- `bun test tests/network.test.ts`
- `bun test tests/config.test.ts`
- `bun test tests/app.test.ts`

### Tests (single test case)
- `bun test tests/network.test.ts -t "accepts loopback hostnames"`
- `bun test -t "resolveServeConfig"`
- `-t` is the same as `--test-name-pattern`

### Useful test flags
- `bun test --coverage`
- `bun test --bail`
- `bun test --only-failures`

### Run server
- `just serve`
- Equivalent: `bun run serve`
- Direct binary form: `./bin/chimera-bench serve`

Examples:
- `just serve -- --hostname 127.0.0.1 --port 4096`
- `CHIMERA_SERVER_PASSWORD=devpass CHIMERA_MODEL_ROOTS=/abs/models just serve -- --hostname 0.0.0.0`
- Health check: `curl -sS http://127.0.0.1:4096/global/health`

### Optional Nix helpers
- `just shell` (enter flake dev shell)
- `just check` (`nix flake check`)
- `just fmt` (`nix fmt flake.nix`)

## Code Style Guidelines
Follow the style already present in `src/` and `tests/`.

### Imports
- Use ESM imports only (no CommonJS)
- Include `.ts` extension for relative imports
- Prefer `node:` builtins (`node:path`, `node:crypto`, etc.)
- Use `import type` for type-only imports
- Keep imports grouped: external first, then internal relative modules

### Formatting
- 2-space indentation
- Semicolons required
- Double-quoted strings by default
- Trailing commas in multiline literals/calls
- Keep functions concise; extract helper functions for parsing/validation
- Add comments only when behavior is non-obvious

### Type Safety
- Keep TypeScript `strict` clean
- Respect `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
- Avoid `any`; use `unknown` and narrow safely
- Add explicit return types for exported functions
- Prefer explicit interfaces/types for public shapes
- Use `readonly` when it clarifies immutable contracts

### Naming
- `camelCase` for functions, variables, parameters
- `PascalCase` for classes, interfaces, type aliases
- `UPPER_SNAKE_CASE` for module-level constants
- Use descriptive boolean names (`isLoopbackHost`, `acceptingNewRuns`)
- Test files should remain `*.test.ts` with descriptive test names

### Error Handling and Validation
- Use specific error classes for expected failures
  - `ServeCommandUsageError`: CLI usage/argument issues
  - `ServeConfigurationError`: runtime/environment config problems
- Validate and normalize input early (CLI args, env vars, headers, origins)
- Keep error messages actionable for users
- In catch blocks, narrow with `instanceof Error` before reading `.message`
- Only swallow errors in explicitly safe cleanup paths

### CLI and Exit Codes
- Exit `0`: success
- Exit `1`: runtime/config failure
- Exit `2`: usage error or unknown command
- Keep help text aligned with actual parser behavior

### HTTP/API Conventions
- Preserve current baseline endpoints
  - `GET /global/health` -> `{ healthy: true, version }`
  - `GET /event` -> SSE connect/heartbeat/disconnect events
- Preserve existing JSON error envelope shape
- Prefer stable error codes (for example `AUTH_REQUIRED`, `CORS_HEADER_NOT_ALLOWED`)
- Keep auth and CORS behavior explicit and conservative by default

## Test Style and Practices
- Use Bun test APIs: `describe`, `test`, `expect` from `bun:test`
- Keep tests focused on behavior edges (parsing, validation, shutdown)
- Use `await expect(...).rejects...` for async failure paths
- Keep fixtures lightweight and inline unless reuse is clear
- When changing CLI/config/auth/CORS behavior, update or add targeted tests

## Agent Workflow Checklist
- Before editing, read nearby implementation and matching tests
- After editing, run at least `bun run lint` and relevant `bun test` targets
- Prefer minimal diffs that satisfy the request
- Avoid adding dependencies unless clearly necessary
- Update docs/help text when changing user-visible behavior
