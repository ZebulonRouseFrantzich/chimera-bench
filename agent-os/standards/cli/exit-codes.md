# CLI Exit Codes

Exit codes are a stable contract across commands.

- `0`: success (including help output).
- `1`: runtime/config failure.
- `2`: usage error (invalid args) or unknown command.

Error classification:

- Throw command-specific usage errors (example: `ServeCommandUsageError`) for argument parsing/unknown options -> exit `2`.
- Throw configuration errors (example: `ServeConfigurationError`) for env/config problems -> exit `1`.
