# SSH Target Model Identifier Validation

Validate SSH `model.identifier` lexically before run creation.

- Require absolute POSIX path (`/`-prefixed).
- Reject control characters.
- Reject any literal `..` path segment before normalization.
- Normalize identifier with `path.posix.normalize`.
- Require normalized identifier to end with `.gguf`.
- Normalize each `remoteModelRoots` entry with `path.posix.normalize`.
  - Keep `/` as-is.
  - Otherwise trim trailing `/`.
- Root containment is slash-aware only:
  - valid: `candidate === root` or `candidate.startsWith(root + "/")`
  - invalid: prefix-only matches like `/models2` for root `/models`

This is a run-target rule (not engine-specific).
