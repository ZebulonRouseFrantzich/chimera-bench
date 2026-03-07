# Run Artifact Store

Run results are persisted under the artifact root (default `runs/`):

- `runs/{runId}/result.json`

Additional artifacts may be persisted under the same directory (server-version dependent):

- `runs/{runId}/manifest.json`
- `runs/{runId}/cases.csv`
- `runs/{runId}/cases.ndjson`
- `runs/{runId}/summary.md`
- `runs/{runId}/bundle.tgz`
- `runs/{runId}/engine.stdout.log`
- `runs/{runId}/engine.stderr.log`

Write rules:

- Write artifacts via an atomic replace (when feasible):
  - write `result.json.tmp-<uuid>`
  - `rename` to `result.json`
- Best-effort cleanup of temp files on failure.

Notes:

- For non-JSON artifacts (CSV/NDJSON/markdown/logs), keep the same atomic write strategy using a temp file + rename.
- For archive bundles, ensure deterministic output when reproducibility is required (stable file order and fixed metadata).

Path safety:

- Treat `runId` as untrusted input.
- Resolve artifact paths and enforce root containment; reject/raise if the resolved path escapes the artifact root.

Errors + observability:

- Client-facing error messages are safe + stable.
- Keep detailed diagnostics in `logReason` for server logs.
- Track last write failure per run (bounded) so API can report persistence failures without re-reading the filesystem.
