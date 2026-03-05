# Sweep Result and Ranking

Persist sweep artifacts in `runs/{runId}/result.json` with deterministic ranking.

## Required sweep result block

```json
{
  "sweep": {
    "axes": { "serverArgs": {}, "requestParams": {} },
    "repetitions": 1,
    "maxCases": 32,
    "plannedCases": 8,
    "ranking": []
  }
}
```

- Preserve stored sweep axes and limits (`repetitions`, `maxCases`, `plannedCases`).
- Ranking may be empty when no case outcomes were recorded.

## Ranking rules (deterministic)

- Repetitions are ranked independently (no aggregation across `.rep-*`).
- Completed cases rank before failed cases.
- Completed sort order:
  1. `tokensPerSecond` desc (normalized to 3 decimals at compare time)
  2. `latencyMs` asc
  3. `caseId` asc (ASCII lexicographic)
- Failed sort order: `caseId` asc.
- `rank` is 1-indexed and contiguous.
