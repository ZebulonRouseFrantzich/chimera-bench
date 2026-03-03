---
applyTo: "tests/**/*.test.ts"
---

Use these standards for test review comments:

- `/agent-os/standards/testing/app-fixtures.md`
- `/agent-os/standards/testing/async-polling.md`
- `/agent-os/standards/testing/log-assertions.md`
- `/agent-os/standards/global/time-based-testing.md`

When reviewing tests, focus on:

- Determinism (bounded polling, no flaky timing assumptions).
- Behavior-focused assertions over implementation detail assertions.
- Fixtures and helpers that match repository patterns.
- Assertions for logs/errors that avoid secret leakage and unsafe content.

Prefer comments that improve reliability and reduce flaky CI outcomes.
