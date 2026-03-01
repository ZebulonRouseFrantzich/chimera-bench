import {
  buildGeneratedArtifacts,
  getAllArtifactEntries,
  projectRelativePath,
  readArtifactFile,
} from "./openapi-artifacts.ts";

const artifacts = await buildGeneratedArtifacts();
const expectedEntries = getAllArtifactEntries(artifacts);
const driftedPaths: string[] = [];

for (const entry of expectedEntries) {
  const existingContents = await readArtifactFile(entry.fileUrl);
  if (existingContents !== entry.contents) {
    driftedPaths.push(projectRelativePath(entry.fileUrl));
  }
}

if (driftedPaths.length > 0) {
  console.error("[chimera-bench] OpenAPI/SDK artifacts are out of date:");
  for (const path of driftedPaths) {
    console.error(`- ${path}`);
  }
  console.error(
    "[chimera-bench] Run `bun run openapi:generate && bun run sdk:generate`.",
  );
  process.exitCode = 1;
} else {
  console.log("[chimera-bench] OpenAPI and SDK artifacts are in sync.");
}
