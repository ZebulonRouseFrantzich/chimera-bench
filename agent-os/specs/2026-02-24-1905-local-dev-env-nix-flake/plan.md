# Spec 0 - Local Development Environment (Nix Flake)

## Objective

Make local development reproducible and low-friction via a Nix flake `devShell`, direnv auto-enter/exit, and a dev-only `Justfile`.

## Context carried from shaping

- Product direction: Bun + TypeScript server-first; frontend later.
- This spec is a prerequisite for the other specs in `agent-os/specs/`.
- The product roadmap in `agent-os/product/roadmap.md` starts at Spec 1; this "Spec 0" is intentionally a foundational dev-tooling spec.
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
   - Ensure the spec folder contains `plan.md`, `shape.md`, `references.md`, `standards.md`, and `visuals/README.md`.
   - Manual testing steps:
     - `ls agent-os/specs/2026-02-24-1905-local-dev-env-nix-flake/`

2. Add `flake.nix` dev shell for Bun/TypeScript development plus common CLI utilities.
   - Provide `devShells.default` that works on Linux + macOS.
   - Include: `bun`, `nodejs` (if needed for tooling), `just`, `git`, `ripgrep`, and common SSL/certs tooling.
   - Keep shell activation fast; avoid heavyweight language toolchains not required by the repo.
   - Manual testing steps:
     - `nix --extra-experimental-features "nix-command flakes" flake check`
     - `nix --extra-experimental-features "nix-command flakes" develop`
     - In the shell: `bun --version && just --version && rg --version`

3. Add `.envrc` (`use flake`) and `.gitignore` for `.direnv/`.
   - Root `.envrc` contains only `use flake`.
   - Root `.gitignore` includes `.direnv/`.
   - Manual testing steps:
     - `direnv allow`
     - Exit and re-enter the repo directory; verify auto enter/exit activates the flake shell.

4. Add dev-only `Justfile` (Nix helpers + minimal Bun placeholders).
   - Provide recipes that wrap Nix commands (`fmt`, `check`, `shell`).
   - Add placeholders for Bun tasks that do not fail when `package.json` does not exist yet.
   - Manual testing steps:
     - `just --list`
     - `just check`
     - `just shell`

5. Document local dev workflow in `CONTRIBUTING.md`.
   - Include: installing Nix, enabling flakes, installing `direnv` + `nix-direnv`, and `direnv allow`.
   - Include: common `just` recipes and when to use them.
   - Manual testing steps:
     - Read `CONTRIBUTING.md` and follow the steps from a fresh shell to confirm they work end-to-end.

6. Verify the full workflow.
   - Required checks:
     - `nix flake check`
     - `nix develop`
     - `direnv allow` + auto enter/exit
   - Manual testing steps:
     - `just check`
     - `just shell`
     - `direnv reload`

## Exit criteria

- A new contributor can run `direnv allow` once and then automatically get a working shell with `bun`, `just`, and other required tools available, on Linux and macOS.
