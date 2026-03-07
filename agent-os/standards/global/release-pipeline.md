# Release Pipeline

Use a tag-driven, binary-first release pipeline where GitHub Releases are the source of truth for distributed artifacts.

## Branching and release trigger

- Keep `main` releasable (trunk-based flow with short-lived feature branches).
- Cut releases from tags on `main`, not from long-lived release branches.
- Release tags are stable-only: `vX.Y.Z` (no prerelease) and trigger `.github/workflows/release.yml`.

## Version alignment

- Application release version source of truth is root `package.json#version`.
- Keep git tag version aligned with root `package.json#version`.
- The release workflow must fail when tag and `package.json` versions do not match.
- CI publishes npm packages at the tag version (shim + platform packages) by rewriting versions in `dist/npm-staging/*`.
- API contract version source of truth is `SERVER_API_VERSION` in
  `src/server/version-metadata.ts`, which follows semver independently from app
  release cadence.
- App-only version bumps do not require OpenAPI/SDK artifact changes unless API
  contract changes are present.

## Required release checks

Before creating artifacts, run and pass:

- `bun run lint`
- `bun run openapi:check`
- `bun test`

## Artifact contract (stable names)

Publish these exact file names to each GitHub Release:

- `chimera-bench-darwin-arm64`
- `chimera-bench-darwin-x64`
- `chimera-bench-linux-arm64`
- `chimera-bench-linux-x64-baseline`
- `chimera-bench-sha256sums.txt`

Rules:

- Keep asset names stable across versions (no version suffix). Installers + npm packaging hardcode these names.
- Keep `chimera-bench-linux-x64-baseline` as the x64 Linux release target to maximize glibc compatibility.
- `chimera-bench-sha256sums.txt` must include all published binary artifacts.
- musl builds are not published yet.
- Add new platforms (for example Windows/musl) by adding new assets + checksum lines; do not rename or repurpose existing assets.
- Build artifacts with `scripts/build-release-artifacts.ts` to keep target and naming policy centralized.

## Integrity and trust model

- Installers must verify downloaded binaries against `chimera-bench-sha256sums.txt`.
- Treat checksums from the same release origin as integrity checks, not full authenticity guarantees.
- For stronger provenance, add a detached signature/attestation workflow (for example Sigstore, minisign, or GPG) before expanding distribution channels.
- Keep custom release repository overrides disabled by default; require explicit unsafe opt-in for non-default sources.

## Binary version behavior

- Compiled binaries must embed release version at build time via `CHIMERA_BENCH_BUILD_VERSION`.
- Runtime version reporting must not rely solely on reading `package.json` from disk.

## Distribution channels

- GitHub Releases: primary distribution source.
- curl installer (`install`): download asset + `chimera-bench-sha256sums.txt`, verify sha256 (no skip), install to user bin directory.
  - Custom release repos are blocked by default; require explicit unsafe opt-in (`CHIMERA_BENCH_ALLOW_CUSTOM_REPO=1`).
  - Keep installer interface stable: `--version`, `--no-modify-path`, and env overrides (`CHIMERA_BENCH_INSTALL_DIR`, `CHIMERA_BENCH_VERSION`, `CHIMERA_BENCH_RELEASE_REPO`).
- npm package (`npm/chimera-bench`): wrapper resolves a platform binary from
  optional dependency packages (no `postinstall` binary downloads).
  - required optional dependency packages:
    - `chimera-bench-darwin-arm64`
    - `chimera-bench-darwin-x64`
    - `chimera-bench-linux-arm64`
    - `chimera-bench-linux-x64-baseline`
  - release workflow prepares platform package binaries from `dist/release/*`
    into `dist/npm-staging/*` before publish using
    `npm/chimera-bench/scripts/prepare-platform-packages.js`.
  - platform package definitions source of truth lives in
    `npm/platform-packages.json`.
  - do not overwrite tracked placeholder files under `npm/chimera-bench-*/bin/`
    during publish prep.
  - npm package README and LICENSE source of truth are repo-root `README.md` and
    `LICENSE`, synced via `npm/chimera-bench/scripts/sync-root-publish-files.js`
    during `prepack`/publish.
  - Publish via npm trusted publishing (GitHub OIDC) + provenance (no long-lived npm token secrets).
- Bun global install support is provided through the same npm package.

## Platform policy

- Official binary distribution is macOS + Linux for now.
- Windows must still be covered in CI (`.github/workflows/ci.yml`) to detect portability regressions early.
- Windows release binaries can be added later without changing the core artifact contract for current platforms.

## Change management for release plumbing

- Treat workflow + build + installers + docs as an atomic change set to avoid cross-channel breakage.
- When changing release targets, artifact names, or download URLs, update all dependent components together:

  - `.github/workflows/release.yml`
  - `scripts/build-release-artifacts.ts`
  - `install`
  - `npm/chimera-bench/bin/chimera-bench.js`
  - `npm/chimera-bench/scripts/prepare-platform-packages.js`
  - `npm/chimera-bench/scripts/sync-root-publish-files.js`
  - `npm/platform-packages.json`
  - user-facing install docs (`README.md`)

- When touching release plumbing, run `bun run release:build` locally and verify `dist/release/` contains the full artifact contract + `chimera-bench-sha256sums.txt`.
- Do not ship partial pipeline updates that break installer or npm channel compatibility.

## CI workflow supply chain hardening

- Pin GitHub Actions to immutable commit SHAs rather than floating major tags.
- Keep pinned action SHAs updated through a dependency update process (for example Dependabot).
