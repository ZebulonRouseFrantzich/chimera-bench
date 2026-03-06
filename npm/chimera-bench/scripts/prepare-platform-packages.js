#!/usr/bin/env node

"use strict";

const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CHECKSUMS_FILE_NAME = "chimera-bench-sha256sums.txt";
const MIN_BINARY_SIZE_BYTES = 1024 * 1024;
const MAX_BINARY_SIZE_BYTES = 250 * 1024 * 1024;

const mainPackageDirectory = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(mainPackageDirectory, "../..");
const releaseArtifactsDirectory = path.join(repositoryRoot, "dist", "release");
const rootLicensePath = path.join(repositoryRoot, "LICENSE");

const platformPackages = [
  {
    name: "chimera-bench-darwin-arm64",
    assetName: "chimera-bench-darwin-arm64",
    directory: path.join(repositoryRoot, "npm", "chimera-bench-darwin-arm64"),
  },
  {
    name: "chimera-bench-darwin-x64",
    assetName: "chimera-bench-darwin-x64",
    directory: path.join(repositoryRoot, "npm", "chimera-bench-darwin-x64"),
  },
  {
    name: "chimera-bench-linux-arm64",
    assetName: "chimera-bench-linux-arm64",
    directory: path.join(repositoryRoot, "npm", "chimera-bench-linux-arm64"),
  },
  {
    name: "chimera-bench-linux-x64-baseline",
    assetName: "chimera-bench-linux-x64-baseline",
    directory: path.join(repositoryRoot, "npm", "chimera-bench-linux-x64-baseline"),
  },
];

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[chimera-bench] prepare-platform-packages failed: ${message}`);
  process.exitCode = 1;
});

async function main() {
  const releaseVersion = resolveReleaseVersion();
  const artifactChecksums = await readArtifactChecksums();

  await prepareMainPackage(releaseVersion);

  for (const platformPackage of platformPackages) {
    await preparePlatformPackage(platformPackage, releaseVersion, artifactChecksums);
  }

  await verifyPreparedPackageVersions(releaseVersion);

  console.log(`[chimera-bench] Prepared npm packages for release ${releaseVersion}.`);
}

function resolveReleaseVersion() {
  const inputVersion = process.argv[2] ?? process.env.CHIMERA_BENCH_RELEASE_VERSION;
  if (!inputVersion) {
    throw new Error(
      "Missing release version. Pass version as argv[2] or set CHIMERA_BENCH_RELEASE_VERSION.",
    );
  }

  const normalizedVersion = inputVersion.replace(/^v/, "").trim();
  if (!SEMVER_PATTERN.test(normalizedVersion)) {
    throw new Error(
      `Invalid release version '${inputVersion}'. Expected semver like 0.0.5 or 0.0.5-rc.1.`,
    );
  }

  return normalizedVersion;
}

async function prepareMainPackage(releaseVersion) {
  const packageJsonPath = path.join(mainPackageDirectory, "package.json");
  const packageJson = await readPackageJson(packageJsonPath);

  packageJson.version = releaseVersion;
  packageJson.optionalDependencies = Object.fromEntries(
    platformPackages.map((platformPackage) => [platformPackage.name, releaseVersion]),
  );

  await writePackageJson(packageJsonPath, packageJson);
}

async function preparePlatformPackage(platformPackage, releaseVersion, artifactChecksums) {
  const packageJsonPath = path.join(platformPackage.directory, "package.json");
  const platformPackageJson = await readPackageJson(packageJsonPath);

  platformPackageJson.version = releaseVersion;
  await writePackageJson(packageJsonPath, platformPackageJson);

  const sourceBinaryPath = path.join(releaseArtifactsDirectory, platformPackage.assetName);
  const targetBinaryPath = path.join(platformPackage.directory, "bin", "chimera-bench");

  await assertFileExists(sourceBinaryPath, platformPackage.assetName);
  await validateArtifactBinary(sourceBinaryPath, platformPackage.assetName);
  await verifyArtifactChecksum(sourceBinaryPath, platformPackage.assetName, artifactChecksums);

  await fs.mkdir(path.dirname(targetBinaryPath), {
    recursive: true,
  });
  await fs.copyFile(sourceBinaryPath, targetBinaryPath);
  await fs.chmod(targetBinaryPath, 0o755);

  await fs.copyFile(rootLicensePath, path.join(platformPackage.directory, "LICENSE"));
}

async function assertFileExists(filePath, label) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(
      `Missing release artifact '${label}' at ${filePath}. Build release artifacts first.`,
    );
  }
}

async function readArtifactChecksums() {
  const checksumPath = path.join(releaseArtifactsDirectory, CHECKSUMS_FILE_NAME);
  await assertFileExists(checksumPath, CHECKSUMS_FILE_NAME);
  const checksumContent = await fs.readFile(checksumPath, "utf8");

  const checksums = new Map();
  for (const line of checksumContent.split(/\r?\n/)) {
    const parsed = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (!parsed) {
      continue;
    }

    checksums.set(parsed[2], parsed[1].toLowerCase());
  }

  return checksums;
}

async function validateArtifactBinary(filePath, label) {
  const stats = await fs.stat(filePath);
  if (stats.size < MIN_BINARY_SIZE_BYTES) {
    throw new Error(
      `Release artifact '${label}' is unexpectedly small (${stats.size} bytes).`,
    );
  }

  if (stats.size > MAX_BINARY_SIZE_BYTES) {
    throw new Error(
      `Release artifact '${label}' is unexpectedly large (${stats.size} bytes).`,
    );
  }
}

async function verifyArtifactChecksum(filePath, assetName, checksums) {
  const expectedChecksum = checksums.get(assetName);
  if (!expectedChecksum) {
    throw new Error(
      `Checksum for release artifact '${assetName}' not found in ${CHECKSUMS_FILE_NAME}.`,
    );
  }

  const actualChecksum = await computeSha256(filePath);
  if (actualChecksum !== expectedChecksum) {
    throw new Error(
      `Checksum mismatch for '${assetName}': expected ${expectedChecksum}, got ${actualChecksum}.`,
    );
  }
}

async function computeSha256(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(filePath);

    input.on("error", reject);
    input.on("data", (chunk) => {
      hash.update(chunk);
    });
    input.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}

async function verifyPreparedPackageVersions(releaseVersion) {
  const mainPackageJson = await readPackageJson(path.join(mainPackageDirectory, "package.json"));
  if (mainPackageJson.version !== releaseVersion) {
    throw new Error(
      `Main npm shim package version '${mainPackageJson.version}' does not match release version '${releaseVersion}'.`,
    );
  }

  for (const platformPackage of platformPackages) {
    const platformVersion = mainPackageJson.optionalDependencies?.[platformPackage.name];
    if (platformVersion !== releaseVersion) {
      throw new Error(
        `Optional dependency '${platformPackage.name}' version '${platformVersion}' does not match '${releaseVersion}'.`,
      );
    }

    const platformPackageJson = await readPackageJson(
      path.join(platformPackage.directory, "package.json"),
    );
    if (platformPackageJson.version !== releaseVersion) {
      throw new Error(
        `Platform package '${platformPackage.name}' version '${platformPackageJson.version}' does not match '${releaseVersion}'.`,
      );
    }
  }
}

async function readPackageJson(packageJsonPath) {
  const rawPackageJson = await fs.readFile(packageJsonPath, "utf8");
  return JSON.parse(rawPackageJson);
}

async function writePackageJson(packageJsonPath, packageJson) {
  await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}
