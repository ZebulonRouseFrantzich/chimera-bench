import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngineCatalog } from "../src/server/engines/engine-catalog.ts";
import {
  ENGINE_PLUGIN_API_VERSION,
  EngineStartFailedError,
  type EnginePlugin,
} from "../src/server/engines/engine-plugin.ts";
import {
  buildApp,
  createRun,
  TEST_MODEL_IDENTIFIER,
} from "./helpers/app-fixture.ts";

describe("run routes", () => {
  test("creates and retrieves a run summary", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const runId = await createRun(app);
    expect(typeof runId).toBe("string");

    const getResponse = await app.request(`http://localhost/runs/${runId}`);
    expect(getResponse.status).toBe(200);

    const getPayload = await getResponse.json();
    expect(getPayload.success).toBe(true);
    expect(getPayload.data.runId).toBe(runId);
    expect(getPayload.data.status).toBe("queued");
  });

  test("reports result as not ready before completion", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const runId = await createRun(app);

    const resultResponse = await app.request(`http://localhost/runs/${runId}/result`);
    expect(resultResponse.status).toBe(409);

    const resultPayload = await resultResponse.json();
    expect(resultPayload.error.code).toBe("RUN_RESULT_NOT_READY");
  });

  test("cancels run idempotently and exposes result", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const runId = await createRun(app);

    const cancelResponse = await app.request(`http://localhost/runs/${runId}/cancel`, {
      method: "POST",
    });
    expect(cancelResponse.status).toBe(200);

    const firstCancelPayload = await cancelResponse.json();
    expect(firstCancelPayload.data.status).toBe("cancelled");

    const secondCancelResponse = await app.request(
      `http://localhost/runs/${runId}/cancel`,
      {
        method: "POST",
      },
    );
    expect(secondCancelResponse.status).toBe(200);

    const secondCancelPayload = await secondCancelResponse.json();
    expect(secondCancelPayload.data.status).toBe("cancelled");

    const resultResponse = await app.request(`http://localhost/runs/${runId}/result`);
    expect(resultResponse.status).toBe(200);

    const resultPayload = await resultResponse.json();
    expect(resultPayload.success).toBe(true);
    expect(resultPayload.data.status).toBe("cancelled");
  });

  test("invokes runtime canceller when cancelling an active run", async () => {
    const { app, runtime } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          executeCase: async () => {
            await Bun.sleep(50);
            return {
              outputText: "ok",
            };
          },
        }),
      ]),
    });

    let cancelCalls = 0;
    const originalCancelActiveRun = runtime.cancelActiveRun.bind(runtime);
    runtime.cancelActiveRun = async (reason: string) => {
      cancelCalls += 1;
      await originalCancelActiveRun(reason);
    };

    const runId = await createRun(app);

    const response = await app.request(`http://localhost/runs/${runId}/cancel`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(cancelCalls).toBe(1);
  });

  test("retains engine cleanup handle when final stop fails", async () => {
    let stopAttempts = 0;

    const { app, runtime } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          stop: async () => {
            stopAttempts += 1;
            if (stopAttempts === 1) {
              throw new Error("stop failed");
            }
          },
        }),
      ]),
    });

    const runId = await createRun(app);
    const status = await waitForTerminalRunStatus(app, runId);
    expect(status).toBe("completed");

    await waitForCondition(() => {
      return stopAttempts >= 1;
    });

    await runtime.cleanupEngineSubprocesses("shutdown");
    expect(stopAttempts).toBe(2);
  });

  test("rejects invalid run creation payloads", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        target: {
          type: "local",
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.success).toBe(false);
    expect(payload.error.code).toBe("VALIDATION_BODY_INVALID");
  });

  test("rejects unsupported engines", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        engineId: "vllm",
        target: {
          type: "local",
        },
        model: {
          identifier: "/tmp/model.gguf",
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("ENGINE_NOT_SUPPORTED");
  });

  test("rejects local targets for engines without local capability", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          capabilities: {
            chatCompletions: true,
            localTarget: false,
            sshTarget: true,
            streaming: true,
          },
        }),
      ]),
    });

    const response = await app.request("http://localhost/runs", {
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
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("ENGINE_TARGET_NOT_SUPPORTED");
  });

  test("rejects local targets with unexpected profileId fields", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        engineId: "llama-cpp",
        target: {
          type: "local",
          profileId: "lab",
        },
        model: {
          identifier: TEST_MODEL_IDENTIFIER,
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_BODY_INVALID");
  });

  test("rejects ssh targets for engines without ssh capability", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([createTestPlugin()]),
    });

    const response = await app.request("http://localhost/runs", {
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
          identifier: "/models/model.gguf",
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("ENGINE_TARGET_NOT_SUPPORTED");
  });

  test("rejects ssh targets when the profile id is missing", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-runs-ssh-targets-"));
    const targetsRootDir = join(tempDirectory, "targets");

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        targetProfilesRootDir: targetsRootDir,
        engines: createEngineCatalog([createSshCapableTestPlugin()]),
      });

      const response = await app.request("http://localhost/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          engineId: "llama-cpp",
          target: {
            type: "ssh",
            profileId: "does-not-exist",
          },
          model: {
            identifier: "/models/model.gguf",
          },
        }),
      });

      expect(response.status).toBe(400);
      const payload = await response.json();
      expect(payload.error.code).toBe("VALIDATION_TARGET_PROFILE_NOT_FOUND");
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("rejects ssh model paths outside slash-aware remote model roots", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-runs-ssh-model-"));
    const targetsRootDir = join(tempDirectory, "targets");

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        targetProfilesRootDir: targetsRootDir,
        engines: createEngineCatalog([createSshCapableTestPlugin()]),
      });

      await createTargetProfile(app, {
        id: "lab",
        remoteModelRoots: ["/models"],
      });

      const response = await app.request("http://localhost/runs", {
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
            identifier: "/models2/other.gguf",
          },
        }),
      });

      expect(response.status).toBe(400);
      const payload = await response.json();
      expect(payload.error.code).toBe("VALIDATION_MODEL_IDENTIFIER_INVALID");
      expect(
        payload.error.details.issues.some((issue: { code?: string }) => {
          return issue.code === "MODEL_IDENTIFIER_OUTSIDE_ALLOWED_ROOTS";
        }),
      ).toBe(true);
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("rejects relative ssh model identifiers", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-runs-ssh-relative-"));
    const targetsRootDir = join(tempDirectory, "targets");

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        targetProfilesRootDir: targetsRootDir,
        engines: createEngineCatalog([createSshCapableTestPlugin()]),
      });

      await createTargetProfile(app, {
        id: "lab",
        remoteModelRoots: ["/models"],
      });

      const response = await app.request("http://localhost/runs", {
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
            identifier: "models/relative.gguf",
          },
        }),
      });

      expect(response.status).toBe(400);
      const payload = await response.json();
      expect(payload.error.code).toBe("VALIDATION_MODEL_IDENTIFIER_INVALID");
      expect(
        payload.error.details.issues.some((issue: { code?: string }) => {
          return issue.code === "MODEL_IDENTIFIER_NOT_ABSOLUTE";
        }),
      ).toBe(true);
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("rejects ssh model identifiers with control characters", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-runs-ssh-control-char-"));
    const targetsRootDir = join(tempDirectory, "targets");

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        targetProfilesRootDir: targetsRootDir,
        engines: createEngineCatalog([createSshCapableTestPlugin()]),
      });

      await createTargetProfile(app, {
        id: "lab",
        remoteModelRoots: ["/models"],
      });

      const response = await app.request("http://localhost/runs", {
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
            identifier: "/models/unsafe.gguf\u0000suffix",
          },
        }),
      });

      expect(response.status).toBe(400);
      const payload = await response.json();
      expect(payload.error.code).toBe("VALIDATION_MODEL_IDENTIFIER_INVALID");
      expect(
        payload.error.details.issues.some((issue: { code?: string }) => {
          return issue.code === "MODEL_IDENTIFIER_CONTROL_CHARACTERS";
        }),
      ).toBe(true);
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("rejects ssh model identifiers that traverse outside remote roots", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-runs-ssh-traversal-"));
    const targetsRootDir = join(tempDirectory, "targets");

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        targetProfilesRootDir: targetsRootDir,
        engines: createEngineCatalog([createSshCapableTestPlugin()]),
      });

      await createTargetProfile(app, {
        id: "lab",
        remoteModelRoots: ["/models"],
      });

      const response = await app.request("http://localhost/runs", {
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
            identifier: "/models/../../etc/passwd.gguf",
          },
        }),
      });

      expect(response.status).toBe(400);
      const payload = await response.json();
      expect(payload.error.code).toBe("VALIDATION_MODEL_IDENTIFIER_INVALID");
      expect(
        payload.error.details.issues.some((issue: { code?: string }) => {
          return issue.code === "MODEL_IDENTIFIER_OUTSIDE_ALLOWED_ROOTS";
        }),
      ).toBe(true);
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("accepts ssh runs with allowlisted model paths and stores targetProfileId", async () => {
    const runArtifactsRootDir = mkdtempSync(join(tmpdir(), "chimera-runs-ssh-artifacts-"));
    const targetsRootDir = mkdtempSync(join(tmpdir(), "chimera-runs-ssh-targets-"));

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        runArtifactsRootDir,
        targetProfilesRootDir: targetsRootDir,
        engines: createEngineCatalog([createSshCapableTestPlugin()]),
      });

      await createTargetProfile(app, {
        id: "lab",
        remoteModelRoots: ["/models"],
      });

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
            identifier: "/models/subdir/../model.gguf",
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
      expect(status).toBe("completed");

      const resultResponse = await app.request(`http://localhost/runs/${runId}/result`);
      expect(resultResponse.status).toBe(200);

      const resultPayload = await resultResponse.json();
      expect(resultPayload.data.result.target).toBe("ssh");
      expect(resultPayload.data.result.targetProfileId).toBe("lab");
      expect(resultPayload.data.result.model.identifier).toBe("/models/model.gguf");
    } finally {
      rmSync(runArtifactsRootDir, {
        recursive: true,
        force: true,
      });
      rmSync(targetsRootDir, {
        recursive: true,
        force: true,
      });
    }
  });

  test("rejects missing model paths with model validation errors", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
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
          identifier: "/tmp/missing-model.gguf",
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_MODEL_IDENTIFIER_INVALID");
    expect(payload.error.details.issues[0].code).toBe("MODEL_IDENTIFIER_NOT_FOUND");
    expect(payload.error.details.issues[0].message).not.toContain("/tmp/missing-model.gguf");
  });

  test("reports invalid model root configuration distinctly", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-runs-misconfig-"));
    const missingRoot = join(tempDirectory, "missing-root");

    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      modelRoots: [missingRoot],
    });

    const response = await app.request("http://localhost/runs", {
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
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_MODEL_ROOTS_INVALID");
    expect(payload.error.details.issues[0].code).toBe("MODEL_ROOT_NOT_FOUND");
    expect(payload.error.details.issues[0].message).not.toContain(missingRoot);

    rmSync(tempDirectory, {
      recursive: true,
      force: true,
    });
  });

  test("enforces CHIMERA_MODEL_ROOTS confinement", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-runs-root-"));
    const rootDirectory = join(tempDirectory, "roots");
    const outsideModel = join(tempDirectory, "outside.gguf");
    mkdirSync(rootDirectory);
    writeFileSync(outsideModel, "fixture");

    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      modelRoots: [rootDirectory],
    });

    const response = await app.request("http://localhost/runs", {
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
          identifier: outsideModel,
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_MODEL_IDENTIFIER_INVALID");
    expect(payload.error.details.issues[0].code).toBe(
      "MODEL_IDENTIFIER_OUTSIDE_ALLOWED_ROOTS",
    );

    rmSync(tempDirectory, {
      recursive: true,
      force: true,
    });
  });

  test("maps plugin validation errors to 400 responses", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          validateRunConfig: async () => ({
            ok: false,
            code: "VALIDATION_ENGINE_OPTIONS_INVALID",
            message: "Unsafe server arguments were supplied.",
            issues: [
              {
                code: "SERVER_ARG_RESERVED",
                message: "--port is reserved.",
                path: "engine.serverArgs[0]",
              },
            ],
          }),
        }),
      ]),
    });

    const response = await app.request("http://localhost/runs", {
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
        engine: {
          serverArgs: ["--port=1234"],
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_ENGINE_OPTIONS_INVALID");
    expect(payload.error.details.issues[0].code).toBe("SERVER_ARG_RESERVED");
  });

  test("sanitizes plugin issue code and path values", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          validateRunConfig: async () => ({
            ok: false,
            code: "validation\nengine\u0000options",
            message: "Unsafe options.",
            issues: [
              {
                code: "server\narg",
                message: "bad arg",
                path: "engine.serverArgs[0]\ncontrol",
              },
            ],
          }),
        }),
      ]),
    });

    const response = await app.request("http://localhost/runs", {
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
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_ENGINE_OPTIONS");
    expect(payload.error.details.issues[0].code).toBe("SERVER_ARG");
    expect(payload.error.details.issues[0].path).toBe("engine.serverArgs[0] control");
  });

  test("reports actionable paths for default server argument validation", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
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
        engine: {
          serverArgs: ["--port=1234"],
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_ENGINE_OPTIONS_INVALID");
    expect(payload.error.details.issues[0].code).toBe("SERVER_ARG_RESERVED");
    expect(payload.error.details.issues[0].path).toBe("engine.serverArgs[0]");
  });

  test("maps thrown plugin validation failures to 500 responses", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          validateRunConfig: async () => {
            throw new Error("Validation backend crashed");
          },
        }),
      ]),
    });

    const response = await app.request("http://localhost/runs", {
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
      }),
    });

    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload.error.code).toBe("ENGINE_VALIDATION_FAILED");
  });

  test("sanitizes reflected engine identifiers in error messages", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        engineId: "vllm\ncontrol",
        target: {
          type: "local",
        },
        model: {
          identifier: "/tmp/model.gguf",
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("ENGINE_NOT_SUPPORTED");
    expect(payload.error.message).not.toContain("\n");
  });

  test("rejects non-JSON run creation requests", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
      },
      body: "engineId=llama-cpp",
    });

    expect(response.status).toBe(415);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_CONTENT_TYPE_INVALID");
  });

  test("rejects oversized run creation body", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
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
        engine: {
          requestParams: {
            oversized: "x".repeat(70_000),
          },
        },
      }),
    });

    expect(response.status).toBe(413);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_BODY_TOO_LARGE");
  });

  test("formats validation paths with array indexes", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
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
        engine: {
          requestParams: {
            nested: ["x".repeat(9000)],
          },
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_BODY_INVALID");
    expect(payload.error.details.issues[0].path).toContain("nested[0]");
  });

  test("rejects timeout values outside allowed bounds", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
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
          runMs: 86_400_001,
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_BODY_INVALID");
    expect(payload.error.details.issues[0].path).toBe("timeouts.runMs");
  });

  test("rejects timeout payloads where case timeout exceeds run timeout", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
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
          caseMs: 2_000,
          runMs: 1_000,
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_BODY_INVALID");
    expect(payload.error.details.issues[0].path).toBe("timeouts.caseMs");
  });

  test("rejects invalid run IDs before lookup", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs/not-a-run-id");
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_PARAMS_INVALID");
  });

  test("returns 404 for unknown run status and event routes", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const unknownRunId = "run_00000000-0000-4000-8000-000000000000";

    const statusResponse = await app.request(`http://localhost/runs/${unknownRunId}`);
    expect(statusResponse.status).toBe(404);
    const statusPayload = await statusResponse.json();
    expect(statusPayload.error.code).toBe("RUN_NOT_FOUND");

    const eventResponse = await app.request(
      `http://localhost/runs/${unknownRunId}/event`,
    );
    expect(eventResponse.status).toBe(404);
    const eventPayload = await eventResponse.json();
    expect(eventPayload.error.code).toBe("RUN_NOT_FOUND");
  });

  test("rejects run creation while shutdown mode is active", async () => {
    const { app, runtime } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    runtime.stopAcceptingNewRuns();

    const response = await app.request("http://localhost/runs", {
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
      }),
    });

    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.error.code).toBe("RUN_SERVER_SHUTTING_DOWN");
  });

  test("enforces single active run concurrency limit", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          executeCase: async () => {
            await Bun.sleep(50);
            return {
              outputText: "ok",
            };
          },
        }),
      ]),
    });

    const firstRunId = await createRun(app);

    const overflowResponse = await app.request("http://localhost/runs", {
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
      }),
    });

    expect(overflowResponse.status).toBe(409);
    const overflowPayload = await overflowResponse.json();
    expect(overflowPayload.error.code).toBe("RUN_CONCURRENCY_LIMIT");

    const cancelResponse = await app.request(`http://localhost/runs/${firstRunId}/cancel`, {
      method: "POST",
    });
    expect(cancelResponse.status).toBe(200);
  });

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
    expect(resultPayload.data.result.summary.totalCases).toBe(3);
    expect(resultPayload.data.result.summary.completedCases).toBe(3);
    expect(resultPayload.data.result.summary.failedCases).toBe(0);
    expect(resultPayload.data.result.cases).toHaveLength(3);
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
      expect(artifact.orchestratorVersion).toBe("0.1.0");
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
              throw new EngineStartFailedError(
                "ENGINE_START_FAILED: llama-server missing",
                {
                  reason: "llama-server missing",
                },
              );
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

  test("fails runs that exceed run timeout budget", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          executeCase: async () => {
            await Bun.sleep(25);
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

    const resultResponse = await app.request(`http://localhost/runs/${runId}/result`);
    expect(resultResponse.status).toBe(200);
    const resultPayload = await resultResponse.json();
    expect(resultPayload.data.result.error.code).toBe("RUN_TIMEOUT_EXCEEDED");
  });

  test("aborts in-flight case execution when case timeout is exceeded", async () => {
    let observedAbort = false;

    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          executeCase: async (context) => {
            return await new Promise(() => {
              context.abortSignal.addEventListener(
                "abort",
                () => {
                  observedAbort = true;
                },
                {
                  once: true,
                },
              );
            });
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
          runMs: 5_000,
          caseMs: 5,
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
    expect(status).toBe("completed");
    expect(observedAbort).toBe(true);

    const resultResponse = await app.request(`http://localhost/runs/${runId}/result`);
    expect(resultResponse.status).toBe(200);
    const resultPayload = await resultResponse.json();
    expect(resultPayload.data.result.summary.failedCases).toBe(3);
    expect(resultPayload.data.result.cases[0].error.code).toBe("RUN_CASE_TIMEOUT");
  });

  test("fails run when startup exceeds run timeout", async () => {
    let observedAbort = false;

    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          start: async (context) => {
            return await new Promise(() => {
              context.abortSignal.addEventListener(
                "abort",
                () => {
                  observedAbort = true;
                },
                {
                  once: true,
                },
              );
            });
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
          runMs: 10,
          caseMs: 5,
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
    expect(observedAbort).toBe(true);

    const resultResponse = await app.request(`http://localhost/runs/${runId}/result`);
    expect(resultResponse.status).toBe(200);
    const resultPayload = await resultResponse.json();
    expect(resultPayload.data.result.error.code).toBe("RUN_TIMEOUT_EXCEEDED");
  });

  test("preserves ENGINE_START_FAILED for startup failures", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          start: async () => {
            throw new EngineStartFailedError(
              "ENGINE_START_FAILED: llama-server missing",
              {
                reason: "llama-server missing",
              },
            );
          },
        }),
      ]),
    });

    const runId = await createRun(app);
    const status = await waitForTerminalRunStatus(app, runId);
    expect(status).toBe("failed");

    const resultResponse = await app.request(`http://localhost/runs/${runId}/result`);
    expect(resultResponse.status).toBe(200);
    const resultPayload = await resultResponse.json();
    expect(resultPayload.data.result.error.code).toBe("ENGINE_START_FAILED");
    expect(resultPayload.data.result.cases[0].error.code).toBe("ENGINE_START_FAILED");
  });
});

async function waitForTerminalRunStatus(
  app: ReturnType<typeof buildApp>["app"],
  runId: string,
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.request(`http://localhost/runs/${runId}`);
    if (response.status !== 200) {
      await Bun.sleep(10);
      continue;
    }

    const payload = await response.json();
    const status = payload.data?.status;
    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      return status;
    }

    await Bun.sleep(10);
  }

  throw new Error(`Run '${runId}' did not reach a terminal status in time.`);
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }

    await Bun.sleep(10);
  }

  throw new Error("Condition did not become true in time.");
}

async function createTargetProfile(
  app: ReturnType<typeof buildApp>["app"],
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const response = await app.request("http://localhost/targets", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      schemaVersion: 1,
      id: "lab",
      displayName: "Lab",
      host: "10.0.0.10",
      username: "ubuntu",
      remoteModelRoots: ["/models"],
      ...overrides,
    }),
  });

  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`Expected target profile upsert status 200/201, got ${response.status}.`);
  }
}

function createSshCapableTestPlugin(
  overrides: Partial<EnginePlugin> = {},
): EnginePlugin {
  return createTestPlugin({
    capabilities: {
      chatCompletions: true,
      localTarget: true,
      sshTarget: true,
      streaming: true,
    },
    ...overrides,
  });
}

function createTestPlugin(
  overrides: Partial<EnginePlugin> = {},
): EnginePlugin {
  return {
    apiVersion: ENGINE_PLUGIN_API_VERSION,
    id: "llama-cpp",
    displayName: "llama.cpp",
    version: "test",
    capabilities: {
      chatCompletions: true,
      localTarget: true,
      sshTarget: false,
      streaming: true,
    },
    validateEnvironment: async () => ({
      status: "ok",
    }),
    validateRunConfig: async (runConfig) => ({
      ok: true,
      normalized: {
        modelIdentifier: runConfig.model.identifier,
        serverArgs: [...runConfig.engine.serverArgs],
        requestParams: { ...runConfig.engine.requestParams },
      },
    }),
    buildLaunchConfig: async (runConfig) => ({
      command: "llama-server",
      args: [...runConfig.engine.serverArgs],
    }),
    start: async () => {
      return;
    },
    waitUntilReady: async () => {
      return;
    },
    executeCase: async () => ({
      outputText: "",
    }),
    collectMetrics: async () => ({}),
    stop: async () => {
      return;
    },
    ...overrides,
  };
}
