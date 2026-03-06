# Contributing

Thanks for your interest in contributing to `chimera-bench`.

## How to contribute

- Open an issue to discuss bugs, feature requests, or design changes.
- For code changes, submit a pull request with a clear description of what changed and why.
- Keep pull requests focused and small when possible.

## Local development environment

This repository uses Nix + direnv for local development.

- `flake.nix` defines the development shell.
- `.envrc` uses `use flake` to auto-enter/exit the shell.
- `Justfile` provides developer convenience commands.

### One-time setup

- Install Nix (with flakes enabled).
- Install `direnv`.
- Install `nix-direnv` and load it from your direnv config (typically `~/.config/direnv/direnvrc`).
- Enable direnv in your shell (`eval "$(direnv hook <your-shell>)"`).

### Per-repo setup

- Run `direnv allow` once in the repository root.
- Use `just --list` to see available developer commands.

Common commands:

- `just check` - run `nix flake check`
- `just fmt` - run `nix fmt flake.nix`
- `just shell` - enter the dev shell manually
- `bun run lint` - typecheck + source quality gate (SLOC and docs)
- `bun run quality:check` - run only source quality checks
- `bun run openapi:generate` - regenerate `openapi/openapi.json`
- `bun run sdk:generate` - regenerate SDK scaffolding in `sdk/generated/`
- `bun run openapi:check` - fail if OpenAPI/SDK artifacts drift

Generated OpenAPI/SDK artifacts are committed to git. Regenerate and include them in your PR when route/schema changes affect API shape.

### Optional dev-mode server logging

Set `CHIMERA_BENCH_DEV=1` to enable verbose request access logs while developing locally.
The default is disabled.

Example:

```bash
CHIMERA_BENCH_DEV=1 chimera-bench serve
```

`just` is for developer ergonomics only. End users should run `chimera-bench ...` commands directly.

## Pull request checklist

- Include tests or verification steps when relevant.
- Update docs/specs when behavior or APIs change.
- Keep source quality checks green (`bun run lint`) and avoid increasing legacy SLOC caps.
- Ensure the branch is up to date with the target branch before requesting review.

## Branching and releases

- `main` is the trunk branch and should stay releasable.
- Use short-lived feature branches for regular development and merge via pull requests.
- Create versioned releases from `main` using tags only (for example, `v0.0.1`).
- Keep git tags aligned with `package.json#version`; the release workflow enforces this.

Release flow:

1. Update `package.json#version` on `main`.
2. Push a matching annotated tag:

   ```bash
   git tag -a v0.0.1 -m "Release v0.0.1"
   git push origin v0.0.1
   ```

3. GitHub Actions publishes release binaries and the npm package automatically.

Release artifact names are intentionally stable across versions to make downstream packaging easier:

- `chimera-bench-darwin-arm64`
- `chimera-bench-darwin-x64`
- `chimera-bench-linux-arm64`
- `chimera-bench-linux-x64-baseline`
- `chimera-bench-sha256sums.txt`

For urgent patches on older versions, create a temporary `release/vX.Y` branch only when needed, cherry-pick fixes, and tag from that branch.

## CLA check (one-time)

- Pull requests are gated by a CLA status check.
- If you have not signed the current CLA version, the bot will ask you to
  comment: `I have read the CLA Document and I hereby sign the CLA`.
- After you sign once for the current CLA version, future pull requests from
  the same GitHub account pass automatically.

## License and contributor agreement

By submitting a contribution (including pull requests, patches, and commits),
you agree to the terms in [CLA.md](./CLA.md). The summary below is for
convenience only; [CLA.md](./CLA.md) is the complete and binding agreement.

In short:

- You confirm you have the legal right to submit your contribution.
- You keep your copyright in your contribution.
- Your contribution is licensed under the MIT License in this repository.
- You grant project maintainers and downstream recipients broad copyright and
  patent rights needed to use and redistribute contributions.
- Any sublicensing or relicensing of contributions by maintainers must use
  OSI-approved open-source licenses.
- Pull requests require one-time CLA acceptance per contributor per CLA version.
