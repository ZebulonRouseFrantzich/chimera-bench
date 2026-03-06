/**
 * Build release binaries and generate checksums for GitHub Releases.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

interface ReleaseTarget {
  readonly compileTarget: CompileTarget;
  readonly assetName: string;
}

type CompileTarget =
  | "bun-darwin-arm64"
  | "bun-darwin-x64"
  | "bun-linux-arm64"
  | "bun-linux-x64-baseline";

const RELEASE_TARGETS: readonly ReleaseTarget[] = [
  {
    compileTarget: "bun-darwin-arm64",
    assetName: "chimera-bench-darwin-arm64",
  },
  {
    compileTarget: "bun-darwin-x64",
    assetName: "chimera-bench-darwin-x64",
  },
  {
    compileTarget: "bun-linux-arm64",
    assetName: "chimera-bench-linux-arm64",
  },
  {
    compileTarget: "bun-linux-x64-baseline",
    assetName: "chimera-bench-linux-x64-baseline",
  },
];

const CHECKSUMS_FILE_NAME = "chimera-bench-sha256sums.txt";
const RELEASE_VERSION_ENV_NAME = "CHIMERA_BENCH_RELEASE_VERSION";
const RELEASE_OUTPUT_DIRECTORY = join(process.cwd(), "dist", "release");
const PACKAGE_JSON_PATH = join(process.cwd(), "package.json");
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

await main();

async function main(): Promise<void> {
  const releaseVersion = await resolveReleaseVersion();

  await rm(RELEASE_OUTPUT_DIRECTORY, {
    recursive: true,
    force: true,
  });
  await mkdir(RELEASE_OUTPUT_DIRECTORY, {
    recursive: true,
  });

  const outputPaths: string[] = [];

  for (const target of RELEASE_TARGETS) {
    const outputPath = await buildTargetArtifact(target, releaseVersion);
    outputPaths.push(outputPath);
  }

  await writeChecksumsFile(outputPaths);

  console.log("[chimera-bench] Built release artifacts:");
  for (const outputPath of [...outputPaths, join(RELEASE_OUTPUT_DIRECTORY, CHECKSUMS_FILE_NAME)]) {
    console.log(`- ${basename(outputPath)}`);
  }
}

async function resolveReleaseVersion(): Promise<string> {
  const packageVersion = await readPackageVersion();
  const rawRequestedVersion = process.env[RELEASE_VERSION_ENV_NAME];

  if (!rawRequestedVersion) {
    return packageVersion;
  }

  const requestedVersion = normalizeVersion(rawRequestedVersion);
  if (requestedVersion !== packageVersion) {
    throw new Error(
      `Release version mismatch: env ${RELEASE_VERSION_ENV_NAME} resolved to '${requestedVersion}', but package.json version is '${packageVersion}'.`,
    );
  }

  return packageVersion;
}

async function readPackageVersion(): Promise<string> {
  const packageJson = (await Bun.file(PACKAGE_JSON_PATH).json()) as {
    version?: unknown;
  };

  if (typeof packageJson.version !== "string") {
    throw new Error("package.json is missing a string version field.");
  }

  return normalizeVersion(packageJson.version);
}

function normalizeVersion(rawVersion: string): string {
  const trimmedVersion = rawVersion.trim();
  const withoutPrefix = trimmedVersion.startsWith("v")
    ? trimmedVersion.slice("v".length)
    : trimmedVersion;

  if (!RELEASE_VERSION_PATTERN.test(withoutPrefix)) {
    throw new Error(
      `Invalid release version '${rawVersion}'. Expected semver like '0.0.1' or '0.0.1-rc.1'.`,
    );
  }

  return withoutPrefix;
}

async function buildTargetArtifact(
  target: ReleaseTarget,
  releaseVersion: string,
): Promise<string> {
  const outputPath = join(RELEASE_OUTPUT_DIRECTORY, target.assetName);

  const buildResult = await Bun.build({
    entrypoints: ["./src/cli-entry.ts"],
    compile: {
      target: target.compileTarget,
      outfile: outputPath,
    },
    bytecode: true,
    minify: true,
    sourcemap: "none",
    define: {
      CHIMERA_BENCH_BUILD_VERSION: JSON.stringify(releaseVersion),
    },
  });

  if (!buildResult.success) {
    throw new Error(
      `Failed to build ${target.assetName} for target '${target.compileTarget}'.`,
    );
  }

  await chmod(outputPath, 0o755);
  return outputPath;
}

async function writeChecksumsFile(outputPaths: readonly string[]): Promise<void> {
  const checksumLines: string[] = [];

  for (const outputPath of outputPaths) {
    const checksum = await computeSha256(outputPath);
    checksumLines.push(`${checksum}  ${basename(outputPath)}`);
  }

  await writeFile(
    join(RELEASE_OUTPUT_DIRECTORY, CHECKSUMS_FILE_NAME),
    `${checksumLines.join("\n")}\n`,
    "utf8",
  );
}

async function computeSha256(path: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const inputStream = createReadStream(path);

    inputStream.on("error", reject);
    inputStream.on("data", (chunk: Buffer) => {
      hash.update(chunk);
    });
    inputStream.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}
