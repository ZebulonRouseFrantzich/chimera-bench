# TTL Cache + In-Flight Deduplication

Use this pattern for bounded in-process caches of expensive work.

Data structure:

- `Map<string, { expiresAt: number, value: T }>`

TTL behavior:

- Inject `now(): number` for testability.
- Sweep expired entries before reads and before writes.

Max entries:

- Enforce `maxEntries` with FIFO eviction using `Map` insertion order.
- Trim after inserts until `cache.size <= maxEntries`.

In-flight dedupe:

- Track `Map<string, Promise<T>>` for active discoveries.
- If a promise exists for a key, await it instead of starting duplicate work.
- Always delete the in-flight entry in `finally`.

Failure policy:

- Do not cache failures by default.
- Concurrent callers observe the same rejection.
- The next call retries fresh discovery.
