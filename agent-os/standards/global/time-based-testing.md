# Time-Based Testing

Use deterministic patterns for testing time-dependent behavior.

## Clock control

- Prefer dependency-injected clocks (for example, `now(): number`) over hardcoded `Date.now()` calls in test-sensitive logic.
- In tests, advance a fake clock explicitly instead of sleeping when validating TTL or timeout behavior.
- Keep production defaults simple (`Date.now`) while allowing test overrides.

## Reliability

- Avoid small real-time sleep margins in unit/integration tests; they are prone to CI flakiness.
- If real-time waits are unavoidable, use large safety buffers and document why deterministic control is not possible.

## Assertions

- Assert both cache-hit behavior and cache-expiry revalidation behavior for TTL logic.
- For timeout logic, assert both success-before-timeout and failure-at-timeout paths.
