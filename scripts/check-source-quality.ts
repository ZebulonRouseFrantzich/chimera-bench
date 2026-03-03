/**
 * Source quality gate for file size and documentation baselines.
 *
 * This check enforces SLOC budgets (with ratcheted legacy caps) and requires
 * a leading module doc for larger source modules.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const SOURCE_MAX_SLOC = 450;
const TEST_MAX_SLOC = 700;
const MODULE_DOC_MIN_SLOC = 200;

const LEGACY_MAX_SLOC: Readonly<Record<string, number>> = {
  "src/server/engines/starter-engine.ts": 2687,
  "src/cli/targets-command.ts": 781,
  "src/server/runs/in-memory-run-store.ts": 762,
  "src/server/ssh/ssh-port-forward.ts": 756,
  "tests/app-runs.test.ts": 1795,
  "tests/starter-engine.test.ts": 1184,
};

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
  const issues: QualityIssue[] = [];

  for (const path of files) {
    const sourceText = await readFile(path, "utf8");
    const sloc = countSloc(path, sourceText);

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
