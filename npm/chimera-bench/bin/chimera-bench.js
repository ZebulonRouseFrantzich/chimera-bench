#!/usr/bin/env node

"use strict";

const { spawn, spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");

const requireFromShim = createRequire(__filename);
const executableName = process.platform === "win32" ? "chimera-bench.exe" : "chimera-bench";

let packageNames;
try {
  packageNames = resolvePlatformPackageNames();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[chimera-bench] ${message}`);
  process.exit(1);
}

const executablePath = resolvePackageBinaryPath(packageNames, executableName);

if (!executablePath) {
  const packageList = packageNames.map((name) => `"${name}"`).join(" or ");
  console.error(
    "[chimera-bench] Could not locate a platform binary package for this installation.",
  );
  console.error(
    `[chimera-bench] Reinstall with your package manager, or install ${packageList} manually.`,
  );
  process.exit(1);
}

const child = spawn(executablePath, process.argv.slice(2), {
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`[chimera-bench] Failed to launch binary: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

function resolvePackageBinaryPath(packageCandidates, binaryName) {
  for (const packageName of packageCandidates) {
    try {
      const packageJsonPath = requireFromShim.resolve(`${packageName}/package.json`);
      const packageDirectory = path.dirname(packageJsonPath);
      const candidatePath = path.join(packageDirectory, "bin", binaryName);

      if (existsSync(candidatePath)) {
        return candidatePath;
      }
    } catch {
      // Continue to next package candidate.
    }
  }

  return null;
}

function resolvePlatformPackageNames() {
  const platform = os.platform();
  const architecture = os.arch();

  if (platform === "darwin") {
    if (architecture === "arm64") {
      return ["chimera-bench-darwin-arm64"];
    }

    if (architecture === "x64") {
      return ["chimera-bench-darwin-x64"];
    }

    throwUnsupportedPlatform(platform, architecture);
  }

  if (platform === "linux") {
    if (isMuslLinux()) {
      throw new Error("musl-based Linux is not yet supported by published chimera-bench npm binaries.");
    }

    if (architecture === "arm64") {
      return ["chimera-bench-linux-arm64"];
    }

    if (architecture === "x64") {
      return ["chimera-bench-linux-x64-baseline"];
    }

    throwUnsupportedPlatform(platform, architecture);
  }

  throwUnsupportedPlatform(platform, architecture);
}

function throwUnsupportedPlatform(platform, architecture) {
  throw new Error(
    `Unsupported platform '${platform}/${architecture}'. npm distribution is currently macOS/Linux only.`,
  );
}

function isMuslLinux() {
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
  }

  if (
    existsSync("/lib/ld-musl-x86_64.so.1") ||
    existsSync("/lib/ld-musl-aarch64.so.1") ||
    existsSync("/usr/lib/ld-musl-x86_64.so.1") ||
    existsSync("/usr/lib/ld-musl-aarch64.so.1")
  ) {
    return true;
  }

  try {
    const lddResult = spawnSync("ldd", ["--version"], {
      encoding: "utf8",
      timeout: 1500,
    });
    const versionText = `${lddResult.stdout ?? ""}${lddResult.stderr ?? ""}`.toLowerCase();
    if (versionText.includes("musl")) {
      return true;
    }
  } catch {
    // Ignore ldd probing failure and default to glibc detection outcome.
  }

  return false;
}
