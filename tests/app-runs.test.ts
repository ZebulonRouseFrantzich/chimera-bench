import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
