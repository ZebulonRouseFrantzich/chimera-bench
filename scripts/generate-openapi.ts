import {
  buildGeneratedArtifacts,
  getOpenApiArtifactEntries,
  projectRelativePath,
  writeArtifactFile,
} from "./openapi-artifacts.ts";

const artifacts = await buildGeneratedArtifacts();

for (const entry of getOpenApiArtifactEntries(artifacts)) {
  await writeArtifactFile(entry.fileUrl, entry.contents);
  console.log(`[chimera-bench] generated ${projectRelativePath(entry.fileUrl)}`);
}
