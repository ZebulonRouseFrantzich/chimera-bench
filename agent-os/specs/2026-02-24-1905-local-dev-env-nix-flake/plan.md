# Spec 0 - Local Development Environment (Nix Flake)

## Objective

Make local development reproducible and low-friction via a Nix flake `devShell`, direnv auto-enter/exit, and a dev-only `Justfile`.

## Context carried from shaping

- Product direction: Bun + TypeScript server-first; frontend later.
- This spec is a prerequisite for the other specs in `agent-os/specs/`.
- `just` is for developers only; end users run `chimera-bench ...` directly.

## Deliverables

- Root `flake.nix` with `devShells.default` supporting Linux + macOS.
- Committed `flake.lock` for reproducible inputs.
- Root `.envrc` containing `use flake` for automatic shell activation (via `direnv` + `nix-direnv`).
- Root `Justfile` for developer workflows (Nix helpers + safe placeholders for future Bun tasks).
- Minimal `.gitignore` entry for `.direnv/`.
- `CONTRIBUTING.md` updates covering Nix/direnv setup and dev commands.

## Standards applied

- N/A (no dev-tooling standards exist yet under `agent-os/standards/`).

## Reference implementations

- User-provided `flake.nix` example in this shaping conversation.
- direnv + nix-direnv docs for `use flake` (see `references.md`).

## Non-goals

- Changing end-user UX or requiring `just`/Nix for end users.
- CI/CD integration for Nix (can be added later).
- Locking in frontend tooling before Spec 7.

## Implementation tasks

1. Save spec documentation (this folder).
2. Add `flake.nix` dev shell for Bun/TypeScript development plus common CLI utilities.
3. Add `.envrc` (`use flake`) and `.gitignore` for `.direnv/`.
4. Add dev-only `Justfile` (Nix helpers + minimal Bun placeholders).
5. Document local dev workflow in `CONTRIBUTING.md`.
6. Verify: `nix flake check`, `nix develop`, `direnv allow` + auto enter/exit.

## Exit criteria

- A new contributor can run `direnv allow` once and then automatically get a working shell with `bun`, `just`, and other required tools available, on Linux and macOS.
