import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngineCatalog } from "../../src/server/engines/engine-catalog.ts";
import { EngineStartFailedError } from "../../src/server/engines/engine-plugin.ts";
import { TEST_APP_VERSION } from "../helpers/app-version.ts";
import {
  buildApp,
  createRun,
  createTestPlugin,
  waitForCondition,
  waitForTerminalRunStatus,
} from "./helpers.ts";

describe("run routes", () => {
  test("runs the starter workload and persists completed results", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          executeCase: async (_context, caseConfig) => ({
            outputText: `completed:${caseConfig.caseId}`,
          }),
          collectMetrics: async () => ({
            sample: true,
          }),
        }),
      ]),
    });

    const runId = await createRun(app);
    const status = await waitForTerminalRunStatus(app, runId);
    expect(status).toBe("completed");

    const resultResponse = await app.request(`http://localhost/runs/${runId}/result`);
    expect(resultResponse.status).toBe(200);

    const resultPayload = await resultResponse.json();
    expect(resultPayload.data.status).toBe("completed");
    expect(resultPayload.data.result.summary.totalCases).toBe(4);
    expect(resultPayload.data.result.summary.completedCases).toBe(4);
    expect(resultPayload.data.result.summary.failedCases).toBe(0);
    expect(resultPayload.data.result.cases).toHaveLength(4);
  });

  test("persists tuning workload identifiers in result.json", async () => {
    const runArtifactsRootDir = mkdtempSync(join(tmpdir(), "chimera-run-artifacts-"));

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        runArtifactsRootDir,
        engines: createEngineCatalog([
          createTestPlugin({
            executeCase: async (_context, caseConfig) => ({
              outputText: `output:${caseConfig.caseId}`,
            }),
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
            identifier: "/tmp/model.gguf",
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

      const artifactPath = join(runArtifactsRootDir, runId, "result.json");
      await waitForCondition(() => {
        return existsSync(artifactPath);
      });

      const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
        workloadId?: string;
        cases?: Array<{
          caseId?: string;
          promptId?: string;
        }>;
      };

      expect(artifact.workloadId).toBe("tuning.v1");
      expect(artifact.cases).toHaveLength(1);
      expect(artifact.cases?.[0]?.caseId).toBe("tuning.v1.case-1");
      expect(artifact.cases?.[0]?.promptId).toBe("tuning.v1.prompt-1");
    } finally {
      rmSync(runArtifactsRootDir, {
        recursive: true,
        force: true,
      });
    }
  });

  test("persists result.json with required schema fields", async () => {
    const runArtifactsRootDir = mkdtempSync(join(tmpdir(), "chimera-run-artifacts-"));

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        runArtifactsRootDir,
        engines: createEngineCatalog([
          createTestPlugin({
            executeCase: async (_context, caseConfig) => ({
              outputText: `output:${caseConfig.caseId}`,
            }),
          }),
        ]),
      });

      const runId = await createRun(app);
      const status = await waitForTerminalRunStatus(app, runId);
      expect(status).toBe("completed");

      const resultResponse = await app.request(`http://localhost/runs/${runId}/result`);
      expect(resultResponse.status).toBe(200);

      const artifactPath = join(runArtifactsRootDir, runId, "result.json");
      await waitForCondition(() => {
        return existsSync(artifactPath);
      });
      expect(existsSync(artifactPath)).toBe(true);

      const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
        runId?: string;
        orchestratorVersion?: string;
        engineId?: string;
        engineVersion?: string;
        target?: string;
        cases?: Array<{
          runId?: string;
          contextTokens?: number;
          engineArgs?: string[];
          ttftMs?: number | null;
          outputTokens?: number;
          tokensPerSecond?: number;
          promptEvalTokensPerSecond?: number | null;
          acceptanceRatio?: number | null;
          error?: {
            code?: string;
          } | null;
        }>;
      };

      expect(artifact.runId).toBe(runId);
      expect(artifact.orchestratorVersion).toBe(TEST_APP_VERSION);
      expect(artifact.engineId).toBe("llama-cpp");
      expect(artifact.engineVersion).toBe("test");
      expect(artifact.target).toBe("local");
      expect(Array.isArray(artifact.cases)).toBe(true);
      expect(artifact.cases?.[0]?.runId).toBe(runId);
      expect(typeof artifact.cases?.[0]?.contextTokens).toBe("number");
      expect(Array.isArray(artifact.cases?.[0]?.engineArgs)).toBe(true);
      expect(artifact.cases?.[0]?.ttftMs).toBeNull();
      expect(typeof artifact.cases?.[0]?.outputTokens).toBe("number");
      expect(typeof artifact.cases?.[0]?.tokensPerSecond).toBe("number");
      expect(artifact.cases?.[0]?.promptEvalTokensPerSecond).toBeNull();
      expect(artifact.cases?.[0]?.acceptanceRatio).toBeNull();
      expect(artifact.cases?.[0]?.error).toBeNull();
    } finally {
      rmSync(runArtifactsRootDir, {
        recursive: true,
        force: true,
      });
    }
  });

  test("persists result.json for failed runs", async () => {
    const runArtifactsRootDir = mkdtempSync(join(tmpdir(), "chimera-run-artifacts-"));

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        runArtifactsRootDir,
        engines: createEngineCatalog([
          createTestPlugin({
            start: async () => {
              throw new EngineStartFailedError("ENGINE_START_FAILED: llama-server missing", {
                reason: "llama-server missing",
              });
            },
          }),
        ]),
      });

      const runId = await createRun(app);
      const status = await waitForTerminalRunStatus(app, runId);
      expect(status).toBe("failed");

      await waitForCondition(() => {
        return existsSync(join(runArtifactsRootDir, runId, "result.json"));
      });
    } finally {
      rmSync(runArtifactsRootDir, {
        recursive: true,
        force: true,
      });
    }
  });

  test("persists result.json for timeout failures", async () => {
    const runArtifactsRootDir = mkdtempSync(join(tmpdir(), "chimera-run-artifacts-"));

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        runArtifactsRootDir,
        engines: createEngineCatalog([
          createTestPlugin({
            executeCase: async () => {
              await Bun.sleep(30);
              return {
                outputText: "slow",
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
            identifier: "/tmp/model.gguf",
          },
          timeouts: {
            runMs: 20,
            caseMs: 20,
          },
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
      expect(status).toBe("failed");

      await waitForCondition(() => {
        return existsSync(join(runArtifactsRootDir, runId, "result.json"));
      });
    } finally {
      rmSync(runArtifactsRootDir, {
        recursive: true,
        force: true,
      });
    }
  });

  test("surfaces actionable persistence failures when result.json cannot be written", async () => {
    const runArtifactsTempDirectory = mkdtempSync(join(tmpdir(), "chimera-run-artifacts-"));
    const blockedRoot = join(runArtifactsTempDirectory, "blocked-root");
    writeFileSync(blockedRoot, "blocked");

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        runArtifactsRootDir: blockedRoot,
        engines: createEngineCatalog([
          createTestPlugin({
            executeCase: async (_context, caseConfig) => ({
              outputText: `output:${caseConfig.caseId}`,
            }),
          }),
        ]),
      });

      const runId = await createRun(app);
      const status = await waitForTerminalRunStatus(app, runId);
      expect(status).toBe("completed");

      const resultResponse = await app.request(`http://localhost/runs/${runId}/result`);
      expect(resultResponse.status).toBe(500);

      const resultPayload = await resultResponse.json();
      expect(resultPayload.error.code).toBe("RUN_RESULT_PERSIST_FAILED");
      expect(resultPayload.error.details.reason).toContain("Failed to persist run artifact");
      expect(resultPayload.error.details.reason).not.toContain(blockedRoot);
    } finally {
      rmSync(runArtifactsTempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("returns cancellation success even if result persistence fails", async () => {
    const runArtifactsTempDirectory = mkdtempSync(join(tmpdir(), "chimera-run-artifacts-"));
    const blockedRoot = join(runArtifactsTempDirectory, "blocked-root");
    writeFileSync(blockedRoot, "blocked");

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        runArtifactsRootDir: blockedRoot,
        engines: createEngineCatalog([
          createTestPlugin({
            executeCase: async () => {
              await Bun.sleep(100);
              return {
                outputText: "slow",
              };
            },
          }),
        ]),
      });

      const runId = await createRun(app);
      const cancelResponse = await app.request(`http://localhost/runs/${runId}/cancel`, {
        method: "POST",
      });
      expect(cancelResponse.status).toBe(200);

      const cancelPayload = await cancelResponse.json();
      expect(cancelPayload.data.status).toBe("cancelled");
    } finally {
      rmSync(runArtifactsTempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("surfaces actionable read failures when persisted result.json is corrupted", async () => {
    const runArtifactsRootDir = mkdtempSync(join(tmpdir(), "chimera-run-artifacts-"));

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        runArtifactsRootDir,
        engines: createEngineCatalog([
          createTestPlugin({
            executeCase: async (_context, caseConfig) => ({
              outputText: `output:${caseConfig.caseId}`,
            }),
          }),
        ]),
      });

      const runId = await createRun(app);
      const status = await waitForTerminalRunStatus(app, runId);
      expect(status).toBe("completed");

      const artifactPath = join(runArtifactsRootDir, runId, "result.json");
      writeFileSync(artifactPath, "{not-json", "utf8");

      const resultResponse = await app.request(`http://localhost/runs/${runId}/result`);
      expect(resultResponse.status).toBe(500);

      const resultPayload = await resultResponse.json();
      expect(resultPayload.error.code).toBe("RUN_RESULT_READ_FAILED");
      expect(resultPayload.error.details.reason).toContain("Failed to parse run artifact");
      expect(resultPayload.error.details.reason).not.toContain(runArtifactsRootDir);
    } finally {
      rmSync(runArtifactsRootDir, {
        recursive: true,
        force: true,
      });
    }
  });
});
