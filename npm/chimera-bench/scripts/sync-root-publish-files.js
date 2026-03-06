#!/usr/bin/env node

"use strict";

const { existsSync, readFileSync } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_ROOT_SEARCH_DEPTH = 24;
const packageRoot = path.resolve(__dirname, "..");
const repositoryRoot = resolveRepositoryRoot();

// Source-of-truth publish files for the npm shim package live at repo root.
const ROOT_FILE_MAPPINGS = [
  {
    source: "README.md",
    destination: "README.md",
  },
  {
    source: "LICENSE",
    destination: "LICENSE",
  },
];

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[chimera-bench] prepack sync failed: ${message}`);
  process.exitCode = 1;
});

async function main() {
  for (const mapping of ROOT_FILE_MAPPINGS) {
    const sourcePath = path.join(repositoryRoot, mapping.source);
    const destinationPath = path.join(packageRoot, mapping.destination);

    await fs.copyFile(sourcePath, destinationPath);
  }

  console.log("[chimera-bench] Synced README.md and LICENSE from repo root.");
}

function resolveRepositoryRoot() {
  if (process.env.CHIMERA_BENCH_REPOSITORY_ROOT) {
    const explicitRoot = path.resolve(process.env.CHIMERA_BENCH_REPOSITORY_ROOT);
    assertValidRepositoryRoot(explicitRoot, "CHIMERA_BENCH_REPOSITORY_ROOT");
    return explicitRoot;
  }

  let candidateDirectory = packageRoot;
  for (let depth = 0; depth < MAX_ROOT_SEARCH_DEPTH; depth += 1) {
    if (looksLikeRepositoryRoot(candidateDirectory)) {
      return candidateDirectory;
    }

    const parentDirectory = path.dirname(candidateDirectory);
    if (parentDirectory === candidateDirectory) {
      break;
    }

    candidateDirectory = parentDirectory;
  }

  throw new Error(
    "Could not resolve repository root. Set CHIMERA_BENCH_REPOSITORY_ROOT explicitly.",
  );
}

function looksLikeRepositoryRoot(candidateDirectory) {
  const hasGitMetadata = existsSync(path.join(candidateDirectory, ".git"));
  if (!hasGitMetadata) {
    return false;
  }

  return getRepositoryRootValidationError(candidateDirectory) === null;
}

function assertValidRepositoryRoot(candidateDirectory, sourceLabel) {
  const validationError = getRepositoryRootValidationError(candidateDirectory);
  if (validationError === null) {
    return;
  }

  throw new Error(
    `Invalid ${sourceLabel} value '${candidateDirectory}': ${validationError}`,
  );
}

function getRepositoryRootValidationError(candidateDirectory) {
  const readmePath = path.join(candidateDirectory, "README.md");
  if (!existsSync(readmePath)) {
    return "missing README.md";
  }

  const licensePath = path.join(candidateDirectory, "LICENSE");
  if (!existsSync(licensePath)) {
    return "missing LICENSE";
  }

  const packageJsonPath = path.join(candidateDirectory, "package.json");
  if (!existsSync(packageJsonPath)) {
    return "missing package.json";
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (packageJson?.name !== "chimera-bench") {
      return `package.json name '${packageJson?.name ?? "<missing>"}' is not 'chimera-bench'`;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `could not parse package.json (${reason})`;
  }

  return null;
}
