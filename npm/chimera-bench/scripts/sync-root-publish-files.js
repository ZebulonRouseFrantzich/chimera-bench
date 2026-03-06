#!/usr/bin/env node

"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");

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
