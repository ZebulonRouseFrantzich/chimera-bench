/**
 * Build a host-native compiled chimera-bench binary for local smoke testing.
 */
import { chmod, mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";

const OUTPUT_DIRECTORY = join(process.cwd(), "dist");
const OUTPUT_BINARY_PATH = join(OUTPUT_DIRECTORY, "chimera-bench");
const PACKAGE_JSON_PATH = join(process.cwd(), "package.json");

await main();

async function main(): Promise<void> {
  const appVersion = await readPackageVersion();

  await mkdir(OUTPUT_DIRECTORY, {
    recursive: true,
  });
  await rm(OUTPUT_BINARY_PATH, {
    force: true,
  });

  const buildResult = await Bun.build({
    entrypoints: ["./src/cli.ts"],
    compile: {
      outfile: OUTPUT_BINARY_PATH,
    },
    bytecode: true,
    minify: true,
    sourcemap: "none",
    define: {
      CHIMERA_BENCH_BUILD_VERSION: JSON.stringify(appVersion),
    },
  });

  if (!buildResult.success) {
    throw new Error("Failed to build local compiled binary at dist/chimera-bench.");
  }

  await chmod(OUTPUT_BINARY_PATH, 0o755);
  console.log(`[chimera-bench] Built ${basename(OUTPUT_BINARY_PATH)} in dist/.`);
}

async function readPackageVersion(): Promise<string> {
  const packageJson = (await Bun.file(PACKAGE_JSON_PATH).json()) as {
    version?: unknown;
  };

  if (typeof packageJson.version !== "string") {
    throw new Error("package.json is missing a string version field.");
  }

  const normalizedVersion = packageJson.version.trim();
  if (normalizedVersion.length === 0) {
    throw new Error("package.json version cannot be empty.");
  }

  return normalizedVersion;
}
