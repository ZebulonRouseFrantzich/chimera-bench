import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createEngineCatalog } from "../../src/server/engines/engine-catalog.ts";
import { CONTEXT_TRUNCATION_MARKER } from "../../src/server/workloads/context-ingestion.ts";
import {
  buildApp,
  createRun,
  createSshCapableTestPlugin,
  createTargetProfile,
  createTestPlugin,
  TEST_MODEL_IDENTIFIER,
  waitForTerminalRunStatus,
} from "./helpers.ts";

describe("run routes", () => {
  test("injects filesystem context docs and persists workload/model provenance", async () => {
    const runArtifactsRootDir = mkdtempSync(join(tmpdir(), "chimera-run-artifacts-"));
    const workloadRoot = mkdtempSync(join(tmpdir(), "chimera-workload-root-"));
    let observedMessages: Array<{ role: string; content: string }> | null = null;

    try {
      const contextText = "MAGIC_PHRASE=kiwi-42\n";
      writeWorkloadPack(
        workloadRoot,
        "context-pack",
        {
          schemaVersion: 1,
          workloadId: "context-demo.v1",
          displayName: "Context demo",
          version: "0.1.0",
          prompts: [
            {
              promptId: "context-demo.v1.prompt-1",
              caseId: "context-demo.v1.case-1",
              contextFiles: ["docs/context.txt"],
              messages: [
                {
                  role: "user",
                  content: "Return MAGIC_PHRASE.",
                },
              ],
            },
          ],
        },
        {
          "docs/context.txt": contextText,
        },
      );

      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        runArtifactsRootDir,
        workloadRoots: [workloadRoot],
        engines: createEngineCatalog([
          createTestPlugin({
            executeCase: async (_context, caseConfig) => {
              observedMessages = caseConfig.messages.map((message) => ({
                role: message.role,
                content: message.content,
              }));
              return {
                outputText: "ok",
              };
            },
          }),
        ]),
      });

      const createResponse = await app.request("http://localhost/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          engineId: "llama-cpp",
          target: {
            type: "local",
          },
          model: {
            identifier: TEST_MODEL_IDENTIFIER,
          },
          workloadId: "context-demo.v1",
        }),
      });
      expect(createResponse.status).toBe(202);

      const createPayload = await createResponse.json();
      const runId = createPayload.data?.runId;
      expect(typeof runId).toBe("string");
      if (typeof runId !== "string") {
        throw new Error("Expected run creation response to include runId.");
      }

      const status = await waitForTerminalRunStatus(app, runId);
      expect(status).toBe("completed");

      const capturedMessages: Array<{ role: string; content: string }> =
        observedMessages ?? [];
      expect(capturedMessages.length).toBeGreaterThan(0);
      expect(capturedMessages[0]?.role).toBe("system");
      expect(capturedMessages[0]?.content).toContain("BEGIN_CONTEXT docs/context.txt");
      expect(capturedMessages[0]?.content).toContain(contextText.trim());
      expect(capturedMessages[0]?.content).toContain("END_CONTEXT docs/context.txt");
      expect(capturedMessages[1]?.role).toBe("user");

      const resultResponse = await app.request(`http://localhost/runs/${runId}/result`);
      expect(resultResponse.status).toBe(200);
      const resultPayload = await resultResponse.json();

      const result = resultPayload.data?.result as {
        workloadPack?: {
          source?: string;
          schemaVersion?: number;
          version?: string;
          digestSha256?: string;
          contextDigests?: Array<{
            path?: string;
            sha256?: string;
            bytes?: number;
            truncated?: boolean;
          }>;
        };
        modelInfo?: {
          resolvedPath?: string;
          bytes?: number | null;
          digestSha256?: string | null;
          unavailableReason?: string;
        };
      };

      expect(result.workloadPack?.source).toBe("filesystem");
      expect(result.workloadPack?.schemaVersion).toBe(1);
      expect(result.workloadPack?.version).toBe("0.1.0");
      expect(result.workloadPack?.digestSha256).toHaveLength(64);
      expect(result.workloadPack?.contextDigests).toEqual([
        {
          path: "docs/context.txt",
          sha256: createHash("sha256").update(contextText).digest("hex"),
          bytes: contextText.length,
          truncated: false,
        },
      ]);

      expect(result.modelInfo?.resolvedPath).toBe(TEST_MODEL_IDENTIFIER);
      expect(result.modelInfo?.bytes).toBe(7);
      expect(result.modelInfo?.digestSha256).toBe(
        createHash("sha256").update("fixture").digest("hex"),
      );
      expect(result.modelInfo?.unavailableReason).toBeUndefined();
    } finally {
      rmSync(workloadRoot, {
        recursive: true,
        force: true,
      });
      rmSync(runArtifactsRootDir, {
        recursive: true,
        force: true,
      });
    }
  });

  test("applies deterministic truncation and omission markers for large context files", async () => {
    const workloadRoot = mkdtempSync(join(tmpdir(), "chimera-workload-root-"));
    let observedSystemMessage = "";

    try {
      writeWorkloadPack(
        workloadRoot,
        "large-context-pack",
        {
          schemaVersion: 1,
          workloadId: "context-large.v1",
          displayName: "Large context",
          version: "0.1.0",
          prompts: [
            {
              promptId: "context-large.v1.prompt-1",
              caseId: "context-large.v1.case-1",
              contextFiles: ["docs/a.txt", "docs/b.txt", "docs/c.txt"],
              messages: [
                {
                  role: "user",
                  content: "summarize",
                },
              ],
            },
          ],
        },
        {
          "docs/a.txt": "a".repeat(70_000),
          "docs/b.txt": "b".repeat(70_000),
          "docs/c.txt": "c".repeat(70_000),
        },
      );

      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        workloadRoots: [workloadRoot],
        engines: createEngineCatalog([
          createTestPlugin({
            executeCase: async (_context, caseConfig) => {
              observedSystemMessage = caseConfig.messages[0]?.content ?? "";
              return {
                outputText: "ok",
              };
            },
          }),
        ]),
      });

      const createResponse = await app.request("http://localhost/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          engineId: "llama-cpp",
          target: {
            type: "local",
          },
          model: {
            identifier: TEST_MODEL_IDENTIFIER,
          },
          workloadId: "context-large.v1",
        }),
      });
      expect(createResponse.status).toBe(202);

      const createPayload = await createResponse.json();
      const runId = createPayload.data?.runId;
      expect(typeof runId).toBe("string");
      if (typeof runId !== "string") {
        throw new Error("Expected run creation response to include runId.");
      }

      const status = await waitForTerminalRunStatus(app, runId);
      expect(status).toBe("completed");

      expect(observedSystemMessage).toContain("BEGIN_CONTEXT docs/a.txt");
      expect(observedSystemMessage).toContain("BEGIN_CONTEXT docs/b.txt");
      expect(observedSystemMessage).not.toContain("BEGIN_CONTEXT docs/c.txt");
      expect(observedSystemMessage).toContain(CONTEXT_TRUNCATION_MARKER.trim());
      expect(observedSystemMessage).toContain("...[omitted context files due to budget count=1]...");
    } finally {
      rmSync(workloadRoot, {
        recursive: true,
        force: true,
      });
    }
  });

  test("returns stable validation errors when context files disappear before run start", async () => {
    const workloadRoot = mkdtempSync(join(tmpdir(), "chimera-workload-root-"));

    try {
      writeWorkloadPack(
        workloadRoot,
        "transient-pack",
        {
          schemaVersion: 1,
          workloadId: "context-transient.v1",
          displayName: "Transient context",
          version: "0.1.0",
          prompts: [
            {
              promptId: "context-transient.v1.prompt-1",
              caseId: "context-transient.v1.case-1",
              contextFiles: ["docs/context.txt"],
              messages: [
                {
                  role: "user",
                  content: "hello",
                },
              ],
            },
          ],
        },
        {
          "docs/context.txt": "temporary",
        },
      );

      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        workloadRoots: [workloadRoot],
      });

      const listResponse = await app.request("http://localhost/workloads");
      expect(listResponse.status).toBe(200);

      rmSync(join(workloadRoot, "transient-pack", "docs", "context.txt"), {
        force: true,
      });

      const createResponse = await app.request("http://localhost/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          engineId: "llama-cpp",
          target: {
            type: "local",
          },
          model: {
            identifier: TEST_MODEL_IDENTIFIER,
          },
          workloadId: "context-transient.v1",
        }),
      });

      expect(createResponse.status).toBe(400);
      const payload = await createResponse.json();
      expect(payload.error.code).toBe("VALIDATION_CONTEXT_FILE_NOT_FOUND");
    } finally {
      rmSync(workloadRoot, {
        recursive: true,
        force: true,
      });
    }
  });

  test("marks model digest unavailable for ssh targets", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createSshCapableTestPlugin({
          executeCase: async (_context, caseConfig) => ({
            outputText: `ok:${caseConfig.caseId}`,
          }),
        }),
      ]),
    });

    await createTargetProfile(app);

    const createResponse = await app.request("http://localhost/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        engineId: "llama-cpp",
        target: {
          type: "ssh",
          profileId: "lab",
        },
        model: {
          identifier: "/models/remote.gguf",
        },
        workloadId: "tuning.v1",
      }),
    });
    expect(createResponse.status).toBe(202);

    const createPayload = await createResponse.json();
    const runId = createPayload.data?.runId;
    expect(typeof runId).toBe("string");
    if (typeof runId !== "string") {
      throw new Error("Expected run creation response to include runId.");
    }

    const status = await waitForTerminalRunStatus(app, runId);
    expect(status).toBe("completed");

    const resultResponse = await app.request(`http://localhost/runs/${runId}/result`);
    expect(resultResponse.status).toBe(200);
    const resultPayload = await resultResponse.json();
    const modelInfo = resultPayload.data?.result?.modelInfo as {
      resolvedPath?: string;
      bytes?: number | null;
      mtimeMs?: number | null;
      digestSha256?: string | null;
      unavailableReason?: string;
    };

    expect(modelInfo.bytes).toBeNull();
    expect(modelInfo.mtimeMs).toBeNull();
    expect(modelInfo.digestSha256).toBeNull();
    expect(modelInfo.unavailableReason).toBe("MODEL_DIGEST_UNAVAILABLE_REMOTE_TARGET");
    expect("resolvedPath" in modelInfo).toBe(false);
  });

  test("reuses model digest cache across runs with unchanged model file", async () => {
    const infoLogs: string[] = [];

    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      logger: {
        info(message) {
          infoLogs.push(message);
        },
        error() {
          return;
        },
      },
      engines: createEngineCatalog([
        createTestPlugin({
          executeCase: async (_context, caseConfig) => ({
            outputText: `ok:${caseConfig.caseId}`,
          }),
        }),
      ]),
    });

    const runA = await createRun(app);
    expect(await waitForTerminalRunStatus(app, runA)).toBe("completed");

    const runB = await createRun(app);
    expect(await waitForTerminalRunStatus(app, runB)).toBe("completed");

    expect(
      infoLogs.some((line) => {
        return line.includes("event=model.digest.cache cache=hit");
      }),
    ).toBe(true);
  });
});

function writeWorkloadPack(
  workloadRoot: string,
  directoryName: string,
  workloadPack: unknown,
  files: Record<string, string>,
): void {
  const packDir = join(workloadRoot, directoryName);
  mkdirSync(packDir, {
    recursive: true,
  });

  writeFileSync(
    join(packDir, "workload.json"),
    `${JSON.stringify(workloadPack, null, 2)}\n`,
    "utf8",
  );

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(packDir, relativePath);
    mkdirSync(dirname(filePath), {
      recursive: true,
    });
    writeFileSync(filePath, content, "utf8");
  }
}
