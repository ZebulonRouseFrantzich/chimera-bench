# Engine Enhancements: llama.cpp Tools - Shaping Notes

## Scope

- Add additional `llama.cpp` execution paths beyond `llama-server`:
  - `llama-cli` as a first-class engine plugin.
  - Optional `llama-bench` integration for microbench throughput signals.
- Add Hugging Face model acquisition via the `hf` CLI that resolves to local GGUF files.
- Add opt-in host/port binding overrides for `llama-server` with explicit safety guardrails.

## Decisions

- Preserve the core run schema and plugin lifecycle contract; new capabilities land in plugins and model resolution.
- Treat downloaded models as normal local GGUF paths after resolution; persist reproducibility metadata via `runs/result-schema` (`modelInfo.resolvedPath` + `modelInfo.digestSha256` when available).
- Keep strict-by-default validation for args/params; allow explicit permissive mode for experimentation.
- Prefer approaches that work well with SSH targets (e.g., `llama-cli` avoids opening remote ports).
- Persist optional engine-level artifacts via `runs/artifact-store` so `manifest.json` / `bundle.tgz` can include them when exports are enabled.
- Visuals: none.

## Assumptions

- The `hf` CLI is available on supported developer/operator environments.
- `llama-cli` and/or `llama-bench` are present in the installed `llama.cpp` distribution on target machines.

## Risks

- Model acquisition increases supply-chain and disk-usage risk; mitigations include pinned hashes, cache confinement, and clear operator controls.
- Host/port overrides can create unsafe exposure if users bind to LAN/WAN without auth.

## Success Criteria

- Users can run comparable runs via `llama-server` or `llama-cli`.
- Hugging Face identifiers resolve to local GGUF files reproducibly.
