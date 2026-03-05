# llama.cpp SSH Remote Cleanup

For SSH-managed runs, perform bounded remote cleanup to prevent leaked `llama-server` processes.

## Cleanup flow (safety-first)

1. `pkill -TERM -f <pattern>`
2. wait grace period
3. `pgrep -f <pattern>` liveness check
4. `pkill -KILL -f <pattern>` only if still alive

- Prioritize leak prevention over fastest shutdown.
- Keep command timeouts and grace periods bounded/configurable.

## Pattern rules

- Match only non-secret markers (command + host + port + `--no-webui`).
- Never include API key material in process-match patterns.
- Use POSIX ERE-safe whitespace class (`[[:space:]]`), not `\\s`.

## Exit semantics

- Normalize SSH command `exitCode: undefined` as success (`0`) for standard exit-0 paths.
- Treat `exitCode: 1` from `pkill`/`pgrep` as no-match/not-alive.
- Treat `null`/signal-only/other exit values as indeterminate and log warning diagnostics.

## Logging and redaction

- Use metadata-first diagnostics (signal, port, status).
- Pass API key redactions into SSH command execution as defense-in-depth.
- Cleanup failures are logged and must not leak secrets.
