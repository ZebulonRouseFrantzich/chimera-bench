# Run Artifact Store

Run results are persisted under the artifact root (default `runs/`):

- `runs/{runId}/result.json`

Write rules:

- Write JSON via an atomic replace:
  - write `result.json.tmp-<uuid>`
  - `rename` to `result.json`
- Best-effort cleanup of temp files on failure.

Path safety:

- Treat `runId` as untrusted input.
- Resolve artifact paths and enforce root containment; reject/raise if the resolved path escapes the artifact root.

Errors + observability:

- Client-facing error messages are safe + stable.
- Keep detailed diagnostics in `logReason` for server logs.
- Track last write failure per run (bounded) so API can report persistence failures without re-reading the filesystem.
