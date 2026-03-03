---
applyTo: "src/cli.ts,src/cli/**/*.ts,bin/chimera-bench,tests/serve-command.test.ts"
---

Use these standards for CLI review comments:

- `/agent-os/standards/cli/arg-parsing.md`
- `/agent-os/standards/cli/exit-codes.md`
- `/agent-os/standards/cli/signal-shutdown.md`
- `/agent-os/standards/global/sanitization-and-safe-errors.md`

When reviewing CLI changes, focus on:

- Strict argument parsing and clear usage errors.
- Exit code mapping correctness (`0` success, `1` runtime failure, `2` usage error).
- Signal and shutdown behavior consistency.
- Help text accuracy and alignment with parser behavior.
- Safe user-facing output (no unsanitized control characters, no secret leakage).

Expect targeted CLI tests when command parsing or exit behavior changes.
