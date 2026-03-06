/**
 * Source quality gate for file size and documentation baselines.
 *
 * This check enforces SLOC budgets (with ratcheted legacy caps) and requires
 * a leading module doc for larger source modules.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const SOURCE_MAX_SLOC = 450;
const TEST_MAX_SLOC = 700;
const MODULE_DOC_MIN_SLOC = 200;
const PLATFORM_PACKAGE_BIN_MAX_BYTES = 1024 * 1024;
const PLATFORM_PACKAGE_MANIFEST_PATH = "npm/platform-packages.json";

const LEGACY_MAX_SLOC: Readonly<Record<string, number>> = {};

const TRIVIA_TOKEN_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
  ts.SyntaxKind.NewLineTrivia,
  ts.SyntaxKind.WhitespaceTrivia,
  ts.SyntaxKind.ShebangTrivia,
  ts.SyntaxKind.ConflictMarkerTrivia,
]);

interface QualityIssue {
  path: string;
  message: string;
}

async function main(): Promise<void> {
  const files = await listProjectTypeScriptFiles();
  const fileSet = new Set(files);
  const slocByPath = new Map<string, number>();
  const issues: QualityIssue[] = [];

  for (const path of files) {
    const sourceText = await readFile(path, "utf8");
    const sloc = countSloc(path, sourceText);
    slocByPath.set(path, sloc);

    const defaultBudget = getDefaultSlocBudget(path);
    if (defaultBudget !== null) {
      const budget = LEGACY_MAX_SLOC[path] ?? defaultBudget;
      if (sloc > budget) {
        const legacyTag = path in LEGACY_MAX_SLOC ? " (legacy cap)" : "";
        issues.push({
          path,
          message: `SLOC ${sloc} exceeds max ${budget}${legacyTag}.`,
        });
      }
    }

    if (path.startsWith("src/") && sloc >= MODULE_DOC_MIN_SLOC) {
      if (!hasLeadingModuleDoc(sourceText)) {
        issues.push({
          path,
          message: `SLOC ${sloc} requires a leading module doc block (/** ... */).`,
        });
      }
    }
  }

  issues.push(...collectLegacyCapMaintenanceIssues(fileSet, slocByPath));
  issues.push(...collectFlatSplitModuleIssues(fileSet));
  issues.push(...(await collectPlatformPackageBinaryIssues()));

  if (issues.length > 0) {
    console.error("[chimera-bench] Source quality checks failed:");
    for (const issue of issues) {
      console.error(`- ${issue.path}: ${issue.message}`);
    }
    console.error(
      "[chimera-bench] Fix violations or split large files to satisfy quality budgets.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[chimera-bench] Source quality checks passed (${files.length} files checked).`,
  );
}

function countSloc(path: string, sourceText: string): number {
  const sourceFile = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    sourceText,
  );

  const linesWithCode = new Set<number>();

  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (!TRIVIA_TOKEN_KINDS.has(token)) {
      const start = scanner.getTokenPos();
      const tokenEndExclusive = scanner.getTextPos();
      const end = Math.max(start, tokenEndExclusive - 1);
      const startLine = sourceFile.getLineAndCharacterOfPosition(start).line;
      const endLine = sourceFile.getLineAndCharacterOfPosition(end).line;

      for (let line = startLine; line <= endLine; line += 1) {
        linesWithCode.add(line);
      }
    }

    token = scanner.scan();
  }

  return linesWithCode.size;
}

function hasLeadingModuleDoc(sourceText: string): boolean {
  const withoutBom = sourceText.startsWith("\uFEFF")
    ? sourceText.slice(1)
    : sourceText;
  return withoutBom.trimStart().startsWith("/**");
}

function getDefaultSlocBudget(path: string): number | null {
  if (path.startsWith("src/")) {
    return SOURCE_MAX_SLOC;
  }

  if (path.startsWith("tests/")) {
    return TEST_MAX_SLOC;
  }

  return null;
}

function collectLegacyCapMaintenanceIssues(
  fileSet: ReadonlySet<string>,
  slocByPath: ReadonlyMap<string, number>,
): QualityIssue[] {
  const issues: QualityIssue[] = [];

  for (const [path, legacyCap] of Object.entries(LEGACY_MAX_SLOC)) {
    if (!fileSet.has(path)) {
      issues.push({
        path,
        message: "Legacy cap entry references a missing file; remove stale LEGACY_MAX_SLOC entry.",
      });
      continue;
    }

    const defaultBudget = getDefaultSlocBudget(path);
    if (defaultBudget === null) {
      issues.push({
        path,
        message:
          "Legacy cap entry is outside default budget scope; remove stale LEGACY_MAX_SLOC entry.",
      });
      continue;
    }

    if (legacyCap <= defaultBudget) {
      issues.push({
        path,
        message:
          `Legacy cap ${legacyCap} is not higher than default budget ${defaultBudget}; ` +
          "remove LEGACY_MAX_SLOC entry.",
      });
      continue;
    }

    const sloc = slocByPath.get(path);
    if (sloc === undefined) {
      continue;
    }

    if (sloc <= defaultBudget) {
      issues.push({
        path,
        message:
          `Legacy cap ${legacyCap} is stale because file SLOC ${sloc} is within ` +
          `default budget ${defaultBudget}; remove LEGACY_MAX_SLOC entry.`,
      });
    }
  }

  return issues;
}

function collectFlatSplitModuleIssues(fileSet: ReadonlySet<string>): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const fileNamesByDir = new Map<string, Set<string>>();

  for (const path of fileSet) {
    if (!path.startsWith("src/") || !path.endsWith(".ts")) {
      continue;
    }

    const slashIndex = path.lastIndexOf("/");
    if (slashIndex < 0) {
      continue;
    }

    const dir = path.slice(0, slashIndex);
    const fileName = path.slice(slashIndex + 1);
    if (fileName === "index.ts" || fileName.endsWith(".d.ts")) {
      continue;
    }

    const names = fileNamesByDir.get(dir) ?? new Set<string>();
    names.add(fileName.slice(0, -3));
    fileNamesByDir.set(dir, names);
  }

  for (const [dir, fileNames] of fileNamesByDir) {
    for (const fileName of fileNames) {
      const splitSiblings = [...fileNames].filter((candidate) => {
        return candidate.startsWith(`${fileName}-`);
      });

      if (splitSiblings.length === 0) {
        continue;
      }

      if (splitSiblings.length < 2) {
        continue;
      }

      const expectedEntrypoint = `${dir}/${fileName}/index.ts`;
      if (fileSet.has(expectedEntrypoint)) {
        continue;
      }

      issues.push({
        path: `${dir}/${fileName}.ts`,
        message:
          "Detected flat split module family. Move these files into a dedicated " +
          `subfolder with a single public entrypoint at '${expectedEntrypoint}'.`,
      });
    }
  }

  return issues;
}

async function collectPlatformPackageBinaryIssues(): Promise<QualityIssue[]> {
  const issues: QualityIssue[] = [];
  const binaryPaths = await loadPlatformPackageBinaryPaths();

  for (const binaryPath of binaryPaths) {
    try {
      const fileStats = await stat(binaryPath);
      if (!fileStats.isFile()) {
        issues.push({
          path: binaryPath,
          message: "Expected a tracked placeholder binary file.",
        });
        continue;
      }

      if (fileStats.size > PLATFORM_PACKAGE_BIN_MAX_BYTES) {
        issues.push({
          path: binaryPath,
          message:
            `File size ${fileStats.size} exceeds ${PLATFORM_PACKAGE_BIN_MAX_BYTES}. ` +
            "Do not commit release binaries; stage publish artifacts in dist/npm-staging instead.",
        });
      }
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        issues.push({
          path: binaryPath,
          message: "Missing platform package placeholder binary file.",
        });
        continue;
      }

      throw error;
    }
  }

  return issues;
}

async function loadPlatformPackageBinaryPaths(): Promise<readonly string[]> {
  const rawManifest = await readFile(PLATFORM_PACKAGE_MANIFEST_PATH, "utf8");
  const parsedManifest = JSON.parse(rawManifest) as {
    platformPackages?: unknown;
  };

  if (!Array.isArray(parsedManifest.platformPackages) || parsedManifest.platformPackages.length === 0) {
    throw new Error(
      `${PLATFORM_PACKAGE_MANIFEST_PATH} is missing a non-empty platformPackages array.`,
    );
  }

  const binaryPaths: string[] = [];
  for (const candidate of parsedManifest.platformPackages) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof (candidate as { name?: unknown }).name !== "string"
    ) {
      throw new Error(
        `${PLATFORM_PACKAGE_MANIFEST_PATH} has an invalid platform package entry (expected { name: string }).`,
      );
    }

    const packageName = (candidate as { name: string }).name.trim();
    if (packageName.length === 0) {
      throw new Error(`${PLATFORM_PACKAGE_MANIFEST_PATH} contains an empty package name.`);
    }

    binaryPaths.push(`npm/${packageName}/bin/chimera-bench`);
  }

  return binaryPaths;
}

async function listProjectTypeScriptFiles(): Promise<string[]> {
  const paths = [
    ...(await listTypeScriptFilesRecursively("src")),
    ...(await listTypeScriptFilesRecursively("tests")),
  ];
  return paths.sort((left, right) => left.localeCompare(right));
}

async function listTypeScriptFilesRecursively(rootDir: string): Promise<string[]> {
  let entries: Array<import("node:fs").Dirent<string>>;

  try {
    entries = await readdir(rootDir, {
      withFileTypes: true,
      encoding: "utf8",
    });
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return [];
    }

    throw error;
  }

  const paths: string[] = [];

  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listTypeScriptFilesRecursively(fullPath);
      paths.push(...nested);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) {
      continue;
    }

    paths.push(toProjectRelativePath(fullPath));
  }

  return paths;
}

function toProjectRelativePath(path: string): string {
  const rawRelativePath = relative(process.cwd(), path);
  if (sep === "/") {
    return rawRelativePath;
  }

  return rawRelativePath.split(sep).join("/");
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }

  return (error as NodeJS.ErrnoException).code === code;
}

await main();
