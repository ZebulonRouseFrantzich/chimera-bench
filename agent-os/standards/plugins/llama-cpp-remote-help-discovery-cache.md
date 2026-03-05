# llama.cpp Remote Help Discovery Cache

Remote `llama-server --help` probing is used for:

- strict `engine.serverArgs` validation (supported flags)
- mixed-GPU guard (GPU selector hints)

Discovery rules:

- Run remote `"<llamaServerPath> --help"` over SSH.
- Allow non-zero exit codes for `--help`.
- Combine stdout+stderr before parsing.
- Treat discovery as successful only when:
  - parsed supported flags set is non-empty
  - required flags exist: `--model`, `--host`, `--port`, `--no-webui`, and `--api-key|--api_key`

Caching rules (per process):

- Cache remote help summaries (supported flags + GPU hints) with defaults:
  - `DEFAULT_REMOTE_HELP_CACHE_TTL_MS = 60_000`
  - `DEFAULT_REMOTE_HELP_CACHE_MAX_ENTRIES = 128`
- Cache key must uniquely identify remote binary + auth context:
  - join `[profile.id, host, port, username, authMethodOrKeyPath, llamaServerPath]` with `"\u0000"`

Cache mechanics:

- Store entries as `{ expiresAt, value }`.
- Sweep expired entries before reads and before writes.
- Trim after insert to max entries (evict oldest insertion-order keys).
- Deduplicate concurrent discovery:
  - keep an in-flight `Map<cacheKey, Promise<summary>>`
  - concurrent callers await the same promise
  - always delete in-flight entry in `finally`

Failure policy:

- Do not cache failures (no negative cache).
- Next call retries discovery.

Optimization:

- When both supported flags and GPU hints are needed, share one probe result for both.
