# Log Metrics Efficiency Analysis - Shaping Notes

## Scope

- Capture engine stdout/stderr in a structured, parseable way.
- Parse `llama.cpp` logs to extract TTFT, prompt eval throughput, and acceptance-style efficiency signals when available.
- Record parse confidence and bounded raw excerpts for auditability.
- Integrate parsed metrics into run artifacts and exports.

## Decisions

- Metrics are best-effort: parsing failures must not crash runs.
- Prefer typed metric fragments and explicit confidence/error reporting.
- Store raw logs as run artifacts when helpful (bounded by size limits).
- Visuals: none.

## Assumptions

- Spec 1 captures engine stdout/stderr and can persist additional run artifacts.
- Spec 3 generates CSV/MD exports derived from `result.json`.

## Risks

- Log formats vary by engine version and build flags; parsing must be defensive.
- Large logs can exhaust memory/disk if not bounded.

## Success Criteria

- Typical `llama.cpp` runs produce non-null deep metrics and mark missing metrics as unavailable with reasons.
