# llama.cpp Mixed-GPU Guard (SSH)

Require explicit GPU selection on mixed-GPU SSH targets.

Applies:

- `target.type = "ssh"`
- Enforced in both `validationMode=strict|permissive`.

When required:

- If remote discovery reports `gpuDeviceCount >= 2` and `engine.serverArgs` has no selector, reject.

Selectors (any satisfies):

- `--device <identifier>` or `-dev <identifier>`
- `--main-gpu <index>` or `-mg <index>`
- `--split-mode none` or `-sm none` (only `none` counts)

Selector value rules:

- Values must be present and non-empty.
- `--device`, `--device=`, `--main-gpu`, `--main-gpu=`, `-mg` without a value do not satisfy.

Validation issue:

- `code: SERVER_ARG_GPU_SELECTION_REQUIRED`
- `path: engine.serverArgs`
- Message must:
  - instruct adding `--device` / `--main-gpu` (or `--split-mode none`)
  - include detected candidates when available (truncate to 8 each)

Discovery failures:

- If discovery fails and no selector is present, fail validation (fail-closed).
- Log one sanitized line:
  - `[chimera-bench] event=run.validation.gpu_selection_discovery_failed targetProfileId=... reason=...`

Notes:

- Do not inject defaults.
- Do not validate selector membership against discovered candidates in v0.0.1.
