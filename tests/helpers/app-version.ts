import { readFileSync } from "node:fs";

interface PackageJsonLike {
  readonly version?: unknown;
}

const PACKAGE_JSON_URL = new URL("../../package.json", import.meta.url);

const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_URL, "utf8")) as PackageJsonLike;

if (typeof packageJson.version !== "string" || packageJson.version.trim().length === 0) {
  throw new Error("Root package.json is missing a non-empty version string.");
}

/**
 * Test source of truth for application release version.
 *
 * This value intentionally mirrors root package.json#version so version bumps
 * do not require scattered hardcoded test updates.
 */
export const TEST_APP_VERSION = packageJson.version.trim();
