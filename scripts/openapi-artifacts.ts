import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenApiDocument } from "../src/server/api/openapi/index.ts";
import { SERVER_API_VERSION } from "../src/server/version-metadata.ts";

type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "HEAD";

interface OpenApiDocumentLike {
  info?: {
    version?: unknown;
  };
  paths?: Record<string, unknown>;
}

interface SdkOperation {
  id: string;
  method: HttpMethod;
  path: string;
  summary: string;
}

interface ArtifactEntry {
  fileUrl: URL;
  contents: string;
}

interface GeneratedArtifacts {
  openApiJson: string;
  sdkClientTs: string;
  sdkIndexTs: string;
}

const PROJECT_ROOT_PATH = fileURLToPath(new URL("../", import.meta.url));

export const OPENAPI_OUTPUT_PATH = new URL("../openapi/openapi.json", import.meta.url);
export const SDK_CLIENT_OUTPUT_PATH = new URL("../sdk/generated/client.ts", import.meta.url);
export const SDK_INDEX_OUTPUT_PATH = new URL("../sdk/generated/index.ts", import.meta.url);

const HTTP_METHOD_ORDER = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
] as const;

export async function buildGeneratedArtifacts(): Promise<GeneratedArtifacts> {
  const openApiDocumentCandidate: unknown = createOpenApiDocument();
  assertOpenApiDocumentLike(openApiDocumentCandidate);

  const openApiDocument = openApiDocumentCandidate;
  // API version source of truth is SERVER_API_VERSION (independent from app releases).
  const openApiVersion =
    typeof openApiDocument.info?.version === "string" &&
    openApiDocument.info.version.length > 0
      ? openApiDocument.info.version
      : SERVER_API_VERSION;
  const operations = extractSdkOperations(openApiDocument);
  if (operations.length === 0) {
    throw new Error("OpenAPI document did not include any operations.");
  }

  return {
    openApiJson: `${JSON.stringify(openApiDocument, null, 2)}\n`,
    sdkClientTs: buildSdkClientSource(openApiVersion, operations),
    sdkIndexTs: buildSdkIndexSource(),
  };
}

export function getOpenApiArtifactEntries(
  artifacts: GeneratedArtifacts,
): ArtifactEntry[] {
  return [
    {
      fileUrl: OPENAPI_OUTPUT_PATH,
      contents: artifacts.openApiJson,
    },
  ];
}

export function getSdkArtifactEntries(artifacts: GeneratedArtifacts): ArtifactEntry[] {
  return [
    {
      fileUrl: SDK_CLIENT_OUTPUT_PATH,
      contents: artifacts.sdkClientTs,
    },
    {
      fileUrl: SDK_INDEX_OUTPUT_PATH,
      contents: artifacts.sdkIndexTs,
    },
  ];
}

export function getAllArtifactEntries(artifacts: GeneratedArtifacts): ArtifactEntry[] {
  return [...getOpenApiArtifactEntries(artifacts), ...getSdkArtifactEntries(artifacts)];
}

export function projectRelativePath(fileUrl: URL): string {
  return relative(PROJECT_ROOT_PATH, fileURLToPath(fileUrl));
}

export async function writeArtifactFile(fileUrl: URL, contents: string): Promise<void> {
  const filePath = fileURLToPath(fileUrl);

  await mkdir(dirname(filePath), {
    recursive: true,
  });
  await writeFile(filePath, contents, "utf8");
}

export async function readArtifactFile(fileUrl: URL): Promise<string | null> {
  try {
    return await readFile(fileURLToPath(fileUrl), "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return null;
    }

    throw error;
  }
}

function extractSdkOperations(document: OpenApiDocumentLike): SdkOperation[] {
  if (!isRecord(document.paths)) {
    return [];
  }

  const seenOperationIds = new Set<string>();
  const operations: SdkOperation[] = [];
  const paths = Object.entries(document.paths).sort(([left], [right]) => {
    return left.localeCompare(right);
  });

  for (const [path, pathValue] of paths) {
    if (!isRecord(pathValue)) {
      continue;
    }

    for (const methodName of HTTP_METHOD_ORDER) {
      const operationValue = pathValue[methodName];
      if (!isRecord(operationValue)) {
        continue;
      }

      const operationId = toUniqueOperationId(
        buildOperationId(methodName, path),
        seenOperationIds,
      );
      const summary =
        typeof operationValue.summary === "string" ? operationValue.summary : "";

      operations.push({
        id: operationId,
        method: methodName.toUpperCase() as HttpMethod,
        path,
        summary,
      });
    }
  }

  return operations;
}

function buildOperationId(methodName: string, path: string): string {
  return `${methodName}${pathToPascalCase(path)}`;
}

function toUniqueOperationId(baseId: string, seenOperationIds: Set<string>): string {
  if (!seenOperationIds.has(baseId)) {
    seenOperationIds.add(baseId);
    return baseId;
  }

  let suffix = 2;
  while (seenOperationIds.has(`${baseId}${suffix}`)) {
    suffix += 1;
  }

  const uniqueId = `${baseId}${suffix}`;
  seenOperationIds.add(uniqueId);
  return uniqueId;
}

function pathToPascalCase(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return "Root";
  }

  return segments
    .map((segment) => {
      const parameterMatch = segment.match(/^\{(.+)\}$/);
      if (parameterMatch) {
        return `By${toPascalCase(parameterMatch[1] ?? "param")}`;
      }

      return toPascalCase(segment);
    })
    .join("");
}

function toPascalCase(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9]+/g, " ").trim();
  if (normalized.length === 0) {
    return "Value";
  }

  return normalized
    .split(/\s+/)
    .map((token) => {
      if (token.length === 0) {
        return "";
      }

      return `${token[0]?.toUpperCase() ?? ""}${token.slice(1)}`;
    })
    .join("");
}

function buildSdkClientSource(apiVersion: string, operations: SdkOperation[]): string {
  const operationLines: string[] = [];

  for (const operation of operations) {
    operationLines.push(`  ${JSON.stringify(operation.id)}: {`);
    operationLines.push(`    method: ${JSON.stringify(operation.method)},`);
    operationLines.push(`    path: ${JSON.stringify(operation.path)},`);
    operationLines.push(`    summary: ${JSON.stringify(operation.summary)},`);
    operationLines.push("  },");
  }

  if (operationLines.length === 0) {
    operationLines.push("  // No OpenAPI operations are currently registered.");
  }

  return [
    "// This file is generated by `bun run sdk:generate`.",
    "// Do not edit this file directly.",
    "",
    'export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";',
    "",
    `export const API_VERSION = ${JSON.stringify(apiVersion)};`,
    "",
    "export const operations = {",
    ...operationLines,
    "} as const;",
    "",
    "export type OperationId = keyof typeof operations;",
    "export type OperationSpec = (typeof operations)[OperationId];",
    "export type OperationPathParams = Record<string, string | number>;",
    "",
    "export function buildOperationUrl(",
    "  baseUrl: string,",
    "  operationId: OperationId,",
    "  pathParams: OperationPathParams = {},",
    "): string {",
    "  const normalizedBaseUrl = baseUrl.replace(/\\/+$/, \"\");",
    "  const pathTemplate = operations[operationId].path;",
    "  const resolvedPath = pathTemplate.replace(/\\{([^}]+)\\}/g, (_match, paramName) => {",
    "    const rawValue = pathParams[paramName];",
    "    if (rawValue === undefined) {",
    "      throw new Error(`Missing path parameter '${paramName}' for operation '${operationId}'.`);",
    "    }",
    "",
    "    return encodeURIComponent(String(rawValue));",
    "  });",
    "",
    "  return `${normalizedBaseUrl}${resolvedPath}`;",
    "}",
    "",
  ].join("\n");
}

function buildSdkIndexSource(): string {
  return [
    "// This file is generated by `bun run sdk:generate`.",
    "// Do not edit this file directly.",
    "",
    "export { API_VERSION, buildOperationUrl, operations } from \"./client.ts\";",
    "export type { HttpMethod, OperationId, OperationPathParams, OperationSpec } from \"./client.ts\";",
    "",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOpenApiDocumentLike(value: unknown): asserts value is OpenApiDocumentLike {
  if (!isRecord(value)) {
    throw new Error("OpenAPI document generator returned a non-object value.");
  }

  const paths = value.paths;
  if (!isRecord(paths)) {
    throw new Error("OpenAPI document is missing a 'paths' object.");
  }
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }

  return (error as NodeJS.ErrnoException).code === code;
}
