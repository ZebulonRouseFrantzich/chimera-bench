# Local Development Environment (Nix Flake) - Shaping Notes

## Scope

- Add a Nix flake-based devShell for developing `chimera-bench` (Bun + TypeScript).
- Add direnv integration via `.envrc` containing `use flake`.
- Add a `Justfile` for developer-only commands to simplify common workflows.

## Decisions

- Platforms: Linux + macOS.
- Reproducibility: commit `flake.lock`.
- `Justfile`: keep initial recipes minimal; focus on Nix/direnv helpers and non-breaking placeholders.
- `just` is dev-only; it must not become part of the end-user interface.
- Visuals: none.
- In-repo references: none.
- Standards: no existing `agent-os/standards/` docs apply to dev tooling (recorded as N/A).

## Context

- Product alignment: follows `agent-os/product/tech-stack.md` (Bun + TypeScript server-first; frontend later).
- Visuals: none.
- References: see `references.md`.

## Standards Applied

- N/A
