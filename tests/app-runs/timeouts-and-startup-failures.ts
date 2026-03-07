import { describe, expect, test } from "bun:test";
import { createEngineCatalog } from "../../src/server/engines/engine-catalog.ts";
import { EngineStartFailedError } from "../../src/server/engines/engine-plugin.ts";
import {
  buildApp,
  createRun,
  createTestPlugin,
  waitForTerminalRunStatus,
} from "./helpers.ts";

describe("run routes", () => {
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
    expect(resultPayload.data.result.summary.failedCases).toBe(4);
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

    const resultResponse = await app.request(`http://localhost/runs/${runId}/result`);
    expect(resultResponse.status).toBe(200);
    const resultPayload = await resultResponse.json();
    expect(resultPayload.data.result.error.code).toBe("ENGINE_START_FAILED");
    expect(resultPayload.data.result.cases[0].error.code).toBe("ENGINE_START_FAILED");
  });
});
