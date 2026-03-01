# Signal Shutdown Handling

For long-running CLI commands (example: `serve`):

- Handle `SIGINT` and `SIGTERM`.
- On first signal:
  - mark shutdown in-progress (dedupe later signals)
  - remove signal handlers
  - print `[chimera-bench] received <SIGNAL>, shutting down...`
  - await `server.stop(<SIGNAL>)`
  - on success print `[chimera-bench] shutdown complete.`
- Propagate `server.stop()` errors to the caller (exit `1`).

Pass the signal string through as the shutdown reason.
