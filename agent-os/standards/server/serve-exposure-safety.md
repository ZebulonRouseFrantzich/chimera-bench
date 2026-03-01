# Serve Exposure Safety

Defaults:

- Bind `127.0.0.1:4096` by default.
- LAN/WAN exposure requires explicit `--hostname`.

Non-loopback safety gates (hard errors, no override):

- Reject non-loopback bind when `CHIMERA_SERVER_PASSWORD` is unset.
- Reject non-loopback bind when `CHIMERA_SERVER_PASSWORD` is weak.
- Reject non-loopback bind when `CHIMERA_MODEL_ROOTS` is unset/empty.

Password policy:

- Minimum length + mixed character classes.
- On loopback binds, weak passwords warn; on non-loopback binds, weak passwords error.

Model root confinement:

- `CHIMERA_MODEL_ROOTS` is a path-delimited list of allowed model root directories.
- `model.identifier` must resolve to a readable `.gguf` under one of the roots.

Network headers:

- Do not trust `X-Forwarded-For`/`X-Real-IP` by default.
- When `CHIMERA_SERVER_TRUST_PROXY=1`, warn at startup and only use behind a trusted proxy.

Browser access:

- CORS is deny-by-default; add allowlisted origins with repeatable `--cors`.
