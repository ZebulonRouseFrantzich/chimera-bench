# llama.cpp Model Identifier Validation

`model.identifier` must be a readable local `.gguf` file.

Rules:

- Trim and reject empty values.
- Reject non-local identifiers (URLs; contains `://`).
- Require `.gguf` extension.
- Resolve to an absolute path and then `realpath()` to a canonical path.
- Require:
  - exists
  - is a file (not a directory)
  - is readable

Model root confinement:

- If `CHIMERA_MODEL_ROOTS` is non-empty:
  - canonical model path must be inside one of the canonicalized roots
  - confinement check uses canonical paths to prevent symlink escapes
- If `CHIMERA_MODEL_ROOTS` is empty:
  - allow any readable local `.gguf` path (still validated)

Issue codes:

- Identifier issues use `MODEL_IDENTIFIER_*`.
- Root issues use `MODEL_ROOT_*`.
