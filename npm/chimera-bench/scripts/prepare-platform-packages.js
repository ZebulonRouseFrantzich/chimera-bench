#!/usr/bin/env node

"use strict";

const { createHash } = require("node:crypto");
const { createReadStream, readFileSync } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CHECKSUMS_FILE_NAME = "chimera-bench-sha256sums.txt";
const MIN_BINARY_SIZE_BYTES = 1024 * 1024;
const MAX_BINARY_SIZE_BYTES = 250 * 1024 * 1024;

const mainPackageDirectory = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(mainPackageDirectory, "../..");
const releaseArtifactsDirectory = path.join(repositoryRoot, "dist", "release");
const npmStagingRootDirectory = path.join(repositoryRoot, "dist", "npm-staging");
const rootLicensePath = path.join(repositoryRoot, "LICENSE");
const rootReadmePath = path.join(repositoryRoot, "README.md");
const platformPackagesManifestPath = path.join(repositoryRoot, "npm", "platform-packages.json");

const mainShimPackage = {
  name: "chimera-bench",
  sourceDirectory: path.join(repositoryRoot, "npm", "chimera-bench"),
  stagingDirectory: path.join(npmStagingRootDirectory, "chimera-bench"),
};

const platformPackages = loadPlatformPackageDefinitions().map((platformPackage) => {
  return {
    ...platformPackage,
    sourceDirectory: path.join(repositoryRoot, "npm", platformPackage.name),
    stagingDirectory: path.join(npmStagingRootDirectory, platformPackage.name),
  };
});

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[chimera-bench] prepare-platform-packages failed: ${message}`);
  process.exitCode = 1;
});

async function main() {
  const releaseVersion = resolveReleaseVersion();
  const artifactChecksums = await readArtifactChecksums();

  await fs.rm(npmStagingRootDirectory, {
    recursive: true,
    force: true,
  });
  await fs.mkdir(npmStagingRootDirectory, {
    recursive: true,
  });

  await prepareMainShimPackage(releaseVersion);

  for (const platformPackage of platformPackages) {
    await preparePlatformPackage(platformPackage, releaseVersion, artifactChecksums);
  }

  await verifyPreparedPackageVersions(releaseVersion);

  console.log(`[chimera-bench] Prepared npm packages for release ${releaseVersion}.`);
  console.log(`[chimera-bench] Staging directory: ${npmStagingRootDirectory}`);
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

function loadPlatformPackageDefinitions() {
  const rawManifest = readFileSync(platformPackagesManifestPath, "utf8");
  const parsedManifest = JSON.parse(rawManifest);
  const candidatePackages = parsedManifest?.platformPackages;

  if (!Array.isArray(candidatePackages) || candidatePackages.length === 0) {
    throw new Error(
      `Invalid platform package manifest at ${platformPackagesManifestPath}: expected non-empty platformPackages array.`,
    );
  }

  const seenPackageNames = new Set();
  const packageDefinitions = [];

  for (const candidate of candidatePackages) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof candidate.name !== "string" ||
      typeof candidate.assetName !== "string"
    ) {
      throw new Error(
        `Invalid platform package entry in ${platformPackagesManifestPath}; expected { name, assetName } strings.`,
      );
    }

    const normalizedName = candidate.name.trim();
    const normalizedAssetName = candidate.assetName.trim();
    if (normalizedName.length === 0 || normalizedAssetName.length === 0) {
      throw new Error(
        `Invalid platform package entry in ${platformPackagesManifestPath}; name and assetName must be non-empty.`,
      );
    }

    if (seenPackageNames.has(normalizedName)) {
      throw new Error(`Duplicate platform package name '${normalizedName}' in ${platformPackagesManifestPath}.`);
    }

    seenPackageNames.add(normalizedName);
    packageDefinitions.push({
      name: normalizedName,
      assetName: normalizedAssetName,
    });
  }

  return packageDefinitions;
}

async function prepareMainShimPackage(releaseVersion) {
  await stagePackageSkeleton(mainShimPackage.sourceDirectory, mainShimPackage.stagingDirectory, [
    "bin",
    "scripts",
    "package.json",
  ]);

  const packageJsonPath = path.join(mainShimPackage.stagingDirectory, "package.json");
  const packageJson = await readPackageJson(packageJsonPath);
  packageJson.version = releaseVersion;
  packageJson.optionalDependencies = Object.fromEntries(
    platformPackages.map((platformPackage) => [platformPackage.name, releaseVersion]),
  );
  await writePackageJson(packageJsonPath, packageJson);

  await fs.copyFile(rootReadmePath, path.join(mainShimPackage.stagingDirectory, "README.md"));
  await fs.copyFile(rootLicensePath, path.join(mainShimPackage.stagingDirectory, "LICENSE"));
}

async function preparePlatformPackage(platformPackage, releaseVersion, artifactChecksums) {
  await stagePackageSkeleton(platformPackage.sourceDirectory, platformPackage.stagingDirectory, [
    "package.json",
    "README.md",
    "LICENSE",
  ]);

  const packageJsonPath = path.join(platformPackage.stagingDirectory, "package.json");
  const platformPackageJson = await readPackageJson(packageJsonPath);
  platformPackageJson.version = releaseVersion;
  await writePackageJson(packageJsonPath, platformPackageJson);

  const sourceBinaryPath = path.join(releaseArtifactsDirectory, platformPackage.assetName);
  const targetBinaryPath = path.join(platformPackage.stagingDirectory, "bin", "chimera-bench");

  await assertFileExists(sourceBinaryPath, platformPackage.assetName);
  await validateArtifactBinary(sourceBinaryPath, platformPackage.assetName);
  await verifyArtifactChecksum(sourceBinaryPath, platformPackage.assetName, artifactChecksums);

  await fs.mkdir(path.dirname(targetBinaryPath), {
    recursive: true,
  });
  await fs.copyFile(sourceBinaryPath, targetBinaryPath);
  await fs.chmod(targetBinaryPath, 0o755);

  await fs.copyFile(rootLicensePath, path.join(platformPackage.stagingDirectory, "LICENSE"));
}

async function stagePackageSkeleton(sourceDirectory, stagingDirectory, entries) {
  await fs.mkdir(stagingDirectory, {
    recursive: true,
  });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDirectory, entry);
    const targetPath = path.join(stagingDirectory, entry);
    await assertFileExists(sourcePath, `${entry} in ${sourceDirectory}`);

    const sourceStats = await fs.lstat(sourcePath);
    if (sourceStats.isSymbolicLink()) {
      throw new Error(
        `Refusing to stage symbolic link '${sourcePath}'. Package skeleton inputs must be regular files or directories.`,
      );
    }

    if (sourceStats.isDirectory()) {
      await fs.cp(sourcePath, targetPath, {
        recursive: true,
        force: true,
        dereference: false,
        verbatimSymlinks: true,
      });
      continue;
    }

    const targetParentDirectory = path.dirname(targetPath);
    if (targetParentDirectory !== stagingDirectory) {
      await fs.mkdir(targetParentDirectory, {
        recursive: true,
      });
    }

    await fs.copyFile(sourcePath, targetPath);
  }
}

async function assertFileExists(filePath, label) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Missing required file '${label}' at ${filePath}.`);
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
    throw new Error(`Release artifact '${label}' is unexpectedly small (${stats.size} bytes).`);
  }

  if (stats.size > MAX_BINARY_SIZE_BYTES) {
    throw new Error(`Release artifact '${label}' is unexpectedly large (${stats.size} bytes).`);
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
  const mainPackageJson = await readPackageJson(path.join(mainShimPackage.stagingDirectory, "package.json"));
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
      path.join(platformPackage.stagingDirectory, "package.json"),
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
