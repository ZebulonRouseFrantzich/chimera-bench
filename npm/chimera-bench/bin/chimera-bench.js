#!/usr/bin/env node

"use strict";

const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");
const executableName = process.platform === "win32" ? "chimera-bench.exe" : "chimera-bench";
const executablePath = path.join(packageRoot, "vendor", executableName);

if (!existsSync(executablePath)) {
  console.error("[chimera-bench] Installed binary not found.");
  console.error("[chimera-bench] Reinstall with: npm i -g chimera-bench");
  console.error(
    "[chimera-bench] If install logs were hidden, retry with --foreground-scripts to inspect postinstall output.",
  );
  process.exit(1);
}

const child = spawn(executablePath, process.argv.slice(2), {
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`[chimera-bench] Failed to launch binary: ${error.message}`);
  process.exit(1);
});
