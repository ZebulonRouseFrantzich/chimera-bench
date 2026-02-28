import { describe, expect, test } from "bun:test";
import { buildApp, createRun } from "./helpers/app-fixture.ts";

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

  test("does not invoke runtime canceller when cancelling queued runs", async () => {
    const { app, runtime } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const runId = await createRun(app);
    let cancelCalls = 0;
    runtime.setActiveRunCanceller(async () => {
      cancelCalls += 1;
    });

    const response = await app.request(`http://localhost/runs/${runId}/cancel`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(cancelCalls).toBe(0);
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

  test("enforces tracked run capacity limit", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    for (let index = 0; index < 1000; index += 1) {
      const runId = await createRun(app);
      expect(runId.startsWith("run_")).toBe(true);
    }

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
    expect(overflowPayload.error.code).toBe("SERVICE_CAPACITY_REACHED");
  });
});
