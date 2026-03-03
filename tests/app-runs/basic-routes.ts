import { describe, expect, test } from "bun:test";
import { createEngineCatalog } from "../../src/server/engines/engine-catalog.ts";
import {
  buildApp,
  createRun,
  createTestPlugin,
  waitForCondition,
  waitForTerminalRunStatus,
} from "./helpers.ts";

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

  test("unregisters engine cleanup handle even when final stop fails", async () => {
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
    expect(stopAttempts).toBe(1);
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

    const eventResponse = await app.request(`http://localhost/runs/${unknownRunId}/event`);
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
});
