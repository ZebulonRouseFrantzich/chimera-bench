# Release Pipeline

Use a tag-driven, binary-first release pipeline where GitHub Releases are the source of truth for distributed artifacts.

## Branching and release trigger

- Keep `main` releasable (trunk-based flow with short-lived feature branches).
- Cut releases from tags on `main`, not from long-lived release branches.
- Release tags use `vX.Y.Z` format and trigger `.github/workflows/release.yml`.

## Version alignment

- Keep git tag version aligned with root `package.json#version`.
- The release workflow must fail when tag and `package.json` versions do not match.
- Keep `npm/chimera-bench/package.json#version` aligned with the same release version before publishing.
- Version bumps require regenerating and committing:
  - `openapi/openapi.json`
  - `sdk/generated/client.ts`
  - `sdk/generated/index.ts`

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

- Keep asset names stable across versions for downstream packaging compatibility.
- `chimera-bench-sha256sums.txt` must include all published binary artifacts.
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
- curl installer (`install`): download binary + checksum from release, validate checksum, install to user bin directory.
- npm package (`npm/chimera-bench`): postinstall downloads exact release-tag binary and verifies checksum.
- Bun global install support is provided through the same npm package.

## Platform policy

- Official binary distribution is macOS + Linux for now.
- Windows must still be covered in CI (`.github/workflows/ci.yml`) to detect portability regressions early.
- Windows release binaries can be added later without changing the core artifact contract for current platforms.

## Change management for release plumbing

When changing release targets, artifact names, or download URLs, update all dependent components together:

- `.github/workflows/release.yml`
- `scripts/build-release-artifacts.ts`
- `install`
- `npm/chimera-bench/scripts/postinstall.js`
- user-facing install docs (`README.md`)

Do not ship partial pipeline updates that break installer or npm channel compatibility.

## CI workflow supply chain hardening

- Pin GitHub Actions to immutable commit SHAs rather than floating major tags.
- Keep pinned action SHAs updated through a dependency update process (for example Dependabot).
