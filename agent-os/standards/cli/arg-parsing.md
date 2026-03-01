# CLI Argument Parsing

Conventions for command flag parsing:

- Implement parsing in the command module (no extra arg parsing deps by default).
- Support both forms:
  - `--flag value`
  - `--flag=value`
- `--help` / `-h` prints command help and exits `0`.
- Unknown options throw a command usage error -> exit `2`.
- Repeatable flags append values (example: `--cors`).
- `--` is ignored (treat as a no-op separator).
- Option values are trimmed and must be non-empty.
- Numeric options validate range and report actionable messages.
