# llama.cpp Stop Escalation

Stopping `llama-server` must be bounded and must reclaim the whole subprocess tree.

Rules:

- Stop the process group (negative pid) to kill subprocess trees.
- Stop sequence:
  1) send `SIGTERM`
  2) wait a short grace period
  3) if still running, log a warning and send `SIGKILL`
  4) wait a short timeout
- Treat missing-process (`ESRCH`) as success.
- If the process group still hasn’t exited after bounded waits, throw an error.
