/**
 * Version source-of-truth policy:
 *
 * - Application release version is sourced from root `package.json#version`
 *   (or `CHIMERA_BENCH_BUILD_VERSION` in compiled binaries).
 * - API contract version is sourced from `SERVER_API_VERSION` below and
 *   follows semver independently from application release cadence.
 *
 * Keep `SERVER_API_VERSION` stable across non-API releases. Bump it only when
 * route/schema/API contract changes warrant a semver update.
 */
export const SERVER_API_VERSION = "0.0.1";
