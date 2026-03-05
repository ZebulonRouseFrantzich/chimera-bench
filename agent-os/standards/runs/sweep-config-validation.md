# Sweep Config Validation

For `POST /runs` with `sweep`, fail unsafe/oversize configs before run creation.

## Core limits

- `MAX_SWEEP_CASES = 256` (server hard ceiling)
- `MAX_SWEEP_AXES_PER_NAMESPACE = 32`
- `MAX_SWEEP_AXIS_VALUES = 256` per axis
- merged argv ceiling: `baseServerArgs + maxSweepAdditional <= 64`

## Required validation behavior

- Fast-fail: if `sweep.maxCases > MAX_SWEEP_CASES`, return `400 VALIDATION_SWEEP_TOO_LARGE`.
- Require integer `repetitions >= 1` and `maxCases >= 1`.
- Require at least one axis across `axes.serverArgs` or `axes.requestParams`; else `VALIDATION_SWEEP_EMPTY`.
- Compute `plannedCases` with bounded multiplication; if `plannedCases > maxCases` or `> MAX_SWEEP_CASES`, return `VALIDATION_SWEEP_TOO_LARGE`.

## Safety rules

- Reject reserved server flags in sweep fragments (`--model`, `--host`, `--port`, `--api-key`, `--api_key`, `--webui`, `--no-webui`).
- Reject denylisted server flags (`--path-prompt-cache`, `--prompt-cache`, `--prompt-cache-all`, `--logdir`, `--public`).
- Reject reserved request param keys: `messages`, `model`, `stream`.
- Sweep request-param values must be JSON-only (no `undefined`, non-finite numbers, `BigInt`, symbols, functions, cycles, non-plain objects).
- Reuse request-param budgets for sweep values (depth/node/string/key constraints).

## Error contract

- Primary codes: `VALIDATION_SWEEP_INVALID`, `VALIDATION_SWEEP_EMPTY`, `VALIDATION_SWEEP_TOO_LARGE`.
- Path reporting for sweep request-param budget issues must reference `sweep.axes.requestParams.<key>[<index>]`.

## Exceptions

- No exceptions in `strict` or `permissive` modes.
