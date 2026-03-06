#!/usr/bin/env node

"use strict";

const { createHash } = require("node:crypto");
const { createReadStream, createWriteStream, existsSync } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const APP_NAME = "chimera-bench";
const CHECKSUMS_FILE_NAME = "chimera-bench-sha256sums.txt";
const DEFAULT_RELEASE_REPOSITORY = "ZebulonRouseFrantzich/chimera-bench";

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[chimera-bench] postinstall failed: ${message}`);
  process.exitCode = 1;
});

async function main() {
  ensureNodeRuntimeSupport();

  const releaseRepository = resolveReleaseRepository();
  const packageRoot = path.resolve(__dirname, "..");
  const packageVersion = await readPackageVersion(path.join(packageRoot, "package.json"));
  const releaseTag = `v${packageVersion}`;
  const releaseBaseUrl = `https://github.com/${releaseRepository}/releases/download/${releaseTag}`;
  const assetName = await detectAssetName();
  const vendorDirectory = path.join(packageRoot, "vendor");
  const installedBinaryPath = path.join(vendorDirectory, APP_NAME);
  const temporaryBinaryPath = `${installedBinaryPath}.tmp-${process.pid}`;

  console.log(`[chimera-bench] Downloading ${assetName} (${releaseTag})...`);

  await fs.mkdir(vendorDirectory, {
    recursive: true,
  });

  const checksums = await downloadText(`${releaseBaseUrl}/${CHECKSUMS_FILE_NAME}`);
  const expectedChecksum = findExpectedChecksum(checksums, assetName);
  if (!expectedChecksum) {
    throw new Error(
      `Checksum entry for '${assetName}' was not found in ${CHECKSUMS_FILE_NAME}.`,
    );
  }

  try {
    await downloadFile(`${releaseBaseUrl}/${assetName}`, temporaryBinaryPath);
    const actualChecksum = await computeSha256(temporaryBinaryPath);
    if (actualChecksum !== expectedChecksum) {
      throw new Error(
        `Checksum mismatch for '${assetName}'. Expected ${expectedChecksum}, got ${actualChecksum}.`,
      );
    }

    await fs.chmod(temporaryBinaryPath, 0o755);
    await fs.rename(temporaryBinaryPath, installedBinaryPath);
    await fs.chmod(installedBinaryPath, 0o755);
  } finally {
    await fs.rm(temporaryBinaryPath, {
      force: true,
    });
  }

  console.log(`[chimera-bench] Installed binary to ${installedBinaryPath}`);
}

function resolveReleaseRepository() {
  const customReleaseRepository = process.env.CHIMERA_BENCH_RELEASE_REPO;
  if (!customReleaseRepository || customReleaseRepository === DEFAULT_RELEASE_REPOSITORY) {
    return DEFAULT_RELEASE_REPOSITORY;
  }

  if (process.env.CHIMERA_BENCH_ALLOW_CUSTOM_REPO !== "1") {
    throw new Error(
      `Refusing custom release repository '${customReleaseRepository}'. Set CHIMERA_BENCH_ALLOW_CUSTOM_REPO=1 to opt in.`,
    );
  }

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(customReleaseRepository)) {
    throw new Error(
      `Invalid CHIMERA_BENCH_RELEASE_REPO '${customReleaseRepository}'. Expected owner/repo.`,
    );
  }

  return customReleaseRepository;
}

function ensureNodeRuntimeSupport() {
  const [majorVersionSegment] = process.versions.node.split(".");
  const majorVersion = Number.parseInt(majorVersionSegment, 10);

  if (!Number.isInteger(majorVersion) || majorVersion < 20) {
    throw new Error("Node.js 20 or newer is required to install chimera-bench.");
  }

  if (typeof fetch === "function") {
    return;
  }

  throw new Error("Global fetch is unavailable. Please use Node.js 20 or newer.");
}

async function readPackageVersion(packageJsonPath) {
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  if (!packageJson || typeof packageJson.version !== "string") {
    throw new Error("npm package metadata is missing a version field.");
  }

  const normalizedVersion = packageJson.version.trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalizedVersion)) {
    throw new Error(`Invalid package version '${packageJson.version}'.`);
  }

  return normalizedVersion;
}

async function detectAssetName() {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") {
      return "chimera-bench-darwin-arm64";
    }

    if (process.arch === "x64") {
      return "chimera-bench-darwin-x64";
    }

    throw new Error(`Unsupported macOS architecture '${process.arch}'.`);
  }

  if (process.platform === "linux") {
    if (await isMuslLinux()) {
      throw new Error(
        "musl-based Linux is not yet supported by the published binary set.",
      );
    }

    if (process.arch === "arm64") {
      return "chimera-bench-linux-arm64";
    }

    if (process.arch === "x64") {
      return "chimera-bench-linux-x64-baseline";
    }

    throw new Error(`Unsupported Linux architecture '${process.arch}'.`);
  }

  throw new Error(
    `Unsupported platform '${process.platform}'. npm distribution is currently macOS/Linux only.`,
  );
}

async function isMuslLinux() {
  if (process.platform !== "linux") {
    return false;
  }

  if (existsSync("/etc/alpine-release")) {
    return true;
  }

  if (process.report && typeof process.report.getReport === "function") {
    const report = process.report.getReport();
    const glibcVersion = report?.header?.glibcVersionRuntime;
    if (typeof glibcVersion === "string" && glibcVersion.length > 0) {
      return false;
    }
    return true;
  }

  return false;
}

async function downloadText(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "chimera-bench-npm-installer",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download '${url}' (${response.status} ${response.statusText}).`);
  }

  return await response.text();
}

async function downloadFile(url, destinationPath) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "chimera-bench-npm-installer",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download '${url}' (${response.status} ${response.statusText}).`);
  }

  if (!response.body) {
    throw new Error(`Download response for '${url}' did not include a body stream.`);
  }

  const output = createWriteStream(destinationPath, {
    mode: 0o755,
  });
  await pipeline(Readable.fromWeb(response.body), output);
}

function findExpectedChecksum(checksumFileContents, assetName) {
  for (const line of checksumFileContents.split(/\r?\n/)) {
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (!match) {
      continue;
    }

    if (match[2] === assetName) {
      return match[1].toLowerCase();
    }
  }

  return null;
}

async function computeSha256(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const inputStream = createReadStream(filePath);

    inputStream.on("error", reject);
    inputStream.on("data", (chunk) => {
      hash.update(chunk);
    });
    inputStream.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}
