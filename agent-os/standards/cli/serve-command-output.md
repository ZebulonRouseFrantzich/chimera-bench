# Serve Command Output

`chimera-bench serve` startup output is operator-facing and mostly stable.

Rules:

- Print startup warnings first:
  - `[chimera-bench] warning: <message>`
- Then print the listening line:
  - `[chimera-bench] listening on http://{hostname}:{resolvedPort}`
- Optional lines (only when enabled/configured):
  - basic auth: `[chimera-bench] basic auth enabled for user '{username}'.`
  - CORS: `[chimera-bench] CORS allowlist: <origins>`
  - mDNS: `[chimera-bench] mDNS advertisement enabled (_chimera-bench._tcp, domain: <domain>).`

Do not reorder/rename these lines without a UX reason.
