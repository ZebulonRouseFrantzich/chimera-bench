# SSH Target Profiles

Persist SSH target profiles as strict, local-only config.

- Store profiles under `~/.chimera-bench/targets/<id>.json`.
- Enforce POSIX permissions:
  - `~/.chimera-bench/targets/` -> `0700`
  - profile files -> `0600`
- Write atomically (temp file + rename); cleanup temp files on failure.
- Do not store private key contents, passphrases, or agent socket values.
  - Auth modes are only:
    - `ssh-agent`
    - `key-path` with absolute `privateKeyPath`
- Validate IDs/connection fields strictly:
  - stable id pattern `^[a-z0-9]+(?:-[a-z0-9]+)*$`
  - hostname/IP + username allowlist
  - port `1..65535`
- Constrain `llamaServerPath` to:
  - `llama-server`, or
  - absolute ASCII path ending with `/llama-server`
  - reject any `..` path segments
- Keep path resolution confined to the storage root.

This standard exists for both local security and profile integrity under failure/concurrency.
