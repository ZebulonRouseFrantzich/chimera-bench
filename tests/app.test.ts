import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server/app.ts";
import { RuntimeControl } from "../src/server/runtime-control.ts";
import type { BasicAuthSettings } from "../src/server/types.ts";

function buildApp(input: {
  auth: BasicAuthSettings;
  corsAllowlist?: string[];
}) {
  const runtime = new RuntimeControl();

  return {
    runtime,
    app: createApp({
      version: "0.1.0",
      auth: input.auth,
      corsAllowlist: input.corsAllowlist ?? [],
      runtime,
    }),
  };
}

async function createRun(app: ReturnType<typeof createApp>): Promise<string> {
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
    }),
  });

  expect(createResponse.status).toBe(202);
  const payload = await createResponse.json();
  return payload.data.runId as string;
}

describe("server app", () => {
  test("returns health payload", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/global/health");
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.success).toBe(true);
    expect(payload.data.healthy).toBe(true);
    expect(payload.data.version).toBe("0.1.0");
    expect(typeof payload.meta.requestId).toBe("string");
    expect(response.headers.get("X-Request-Id")).toBe(payload.meta.requestId);
  });

  test("serves OpenAPI docs", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/doc");
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.openapi).toBe("3.1.0");
    expect(payload.paths["/global/health"]).toBeDefined();
    expect(payload.paths["/runs"]).toBeDefined();
  });

  test("lists engines with envelope", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/engines");
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.success).toBe(true);
    expect(payload.data.engines).toHaveLength(1);
    expect(payload.data.engines[0].id).toBe("llama-cpp");
  });

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

  test("invokes runtime canceller when cancelling active runs", async () => {
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
    expect(cancelCalls).toBe(1);
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

  test("requires auth when configured", async () => {
    const { app } = buildApp({
      auth: {
        enabled: true,
        username: "chimera",
        password: "devpass",
      },
    });

    const unauthorized = await app.request("http://localhost/global/health", {
      headers: {
        "X-Forwarded-For": "10.0.0.10",
      },
    });
    expect(unauthorized.status).toBe(401);

    const token = Buffer.from("chimera:devpass").toString("base64");
    const authorized = await app.request("http://localhost/global/health", {
      headers: {
        Authorization: `Basic ${token}`,
      },
    });

    expect(authorized.status).toBe(200);
  });

  test("applies auth middleware to docs and SSE endpoints", async () => {
    const { app } = buildApp({
      auth: {
        enabled: true,
        username: "chimera",
        password: "devpass",
      },
    });

    const docsUnauthorized = await app.request("http://localhost/doc");
    expect(docsUnauthorized.status).toBe(401);

    const sseUnauthorized = await app.request("http://localhost/event");
    expect(sseUnauthorized.status).toBe(401);

    const token = Buffer.from("chimera:devpass").toString("base64");
    const docsAuthorized = await app.request("http://localhost/doc", {
      headers: {
        Authorization: `Basic ${token}`,
      },
    });
    expect(docsAuthorized.status).toBe(200);
  });

  test("rate-limits repeated authentication failures", async () => {
    const { app } = buildApp({
      auth: {
        enabled: true,
        username: "chimera",
        password: "devpass",
      },
    });

    for (let index = 0; index < 10; index += 1) {
      const response = await app.request("http://localhost/global/health", {
        headers: {
          "X-Forwarded-For": "10.0.0.50",
        },
      });
      expect(response.status).toBe(401);
    }

    const blocked = await app.request("http://localhost/global/health", {
      headers: {
        "X-Forwarded-For": "10.0.0.50",
      },
    });

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeDefined();
  });

  test("ignores forwarded headers unless trust proxy mode is enabled", async () => {
    const { app } = buildApp({
      auth: {
        enabled: true,
        username: "chimera",
        password: "devpass",
      },
    });

    for (let index = 0; index < 10; index += 1) {
      const response = await app.request("http://localhost/global/health", {
        headers: {
          "X-Forwarded-For": `10.0.0.${index + 1}`,
        },
      });
      expect(response.status).toBe(401);
    }

    const blocked = await app.request("http://localhost/global/health", {
      headers: {
        "X-Forwarded-For": "10.0.0.200",
      },
    });
    expect(blocked.status).toBe(429);
  });

  test("uses forwarded headers for rate limiting in trust proxy mode", async () => {
    const { app } = buildApp({
      auth: {
        enabled: true,
        username: "chimera",
        password: "devpass",
        trustProxy: true,
      },
    });

    for (let index = 0; index < 10; index += 1) {
      const response = await app.request("http://localhost/global/health", {
        headers: {
          "X-Forwarded-For": "10.10.10.10",
        },
      });
      expect(response.status).toBe(401);
    }

    const blocked = await app.request("http://localhost/global/health", {
      headers: {
        "X-Forwarded-For": "10.10.10.10",
      },
    });
    expect(blocked.status).toBe(429);

    const differentAddress = await app.request("http://localhost/global/health", {
      headers: {
        "X-Forwarded-For": "10.10.10.11",
      },
    });
    expect(differentAddress.status).toBe(401);
  });

  test("handles auth preflight requests", async () => {
    const { app } = buildApp({
      auth: {
        enabled: true,
        username: "chimera",
        password: "devpass",
      },
      corsAllowlist: ["http://localhost:5173"],
    });

    const response = await app.request("http://localhost/global/health", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Authorization",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:5173",
    );
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
      "Authorization",
    );
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  test("rejects non-allowlisted CORS request headers", async () => {
    const { app } = buildApp({
      auth: {
        enabled: true,
        username: "chimera",
        password: "devpass",
      },
      corsAllowlist: ["http://localhost:5173"],
    });

    const response = await app.request("http://localhost/global/health", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Authorization, X-Unsafe-Header",
      },
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("CORS_HEADER_NOT_ALLOWED");
  });

  test("does not short-circuit preflight for non-allowlisted origins", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      corsAllowlist: ["http://localhost:5173"],
    });

    const response = await app.request("http://localhost/global/health", {
      method: "OPTIONS",
      headers: {
        Origin: "http://example.com",
        "Access-Control-Request-Method": "GET",
      },
    });

    expect(response.status).toBe(404);
  });

  test("omits CORS headers for non-allowlisted origins", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      corsAllowlist: ["http://localhost:5173"],
    });

    const response = await app.request("http://localhost/global/health", {
      headers: {
        Origin: "http://example.com",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("streams server connection events and closes cleanly", async () => {
    const { app, runtime } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/event");
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-Id")).toBeDefined();

    const body = response.body;
    expect(body).not.toBeNull();
    if (!body) {
      return;
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();

    const firstChunk = await reader.read();
    const firstPayload = firstChunk.value ? decoder.decode(firstChunk.value) : "";
    expect(firstPayload).toContain("event: server.connected");
    expect(runtime.getOpenSseStreamCount()).toBe(1);

    runtime.closeSseStreams("test-shutdown");

    const secondChunk = await reader.read();
    const secondPayload = secondChunk.value ? decoder.decode(secondChunk.value) : "";
    expect(secondChunk.done || secondPayload.includes("event: server.disconnected")).toBe(
      true,
    );

    await reader.cancel();
    expect(runtime.getOpenSseStreamCount()).toBe(0);
  });

  test("cleans up server SSE stream on client disconnect", async () => {
    const { app, runtime } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/event");
    expect(response.status).toBe(200);

    const body = response.body;
    expect(body).not.toBeNull();
    if (!body) {
      return;
    }

    const reader = body.getReader();
    await reader.read();
    expect(runtime.getOpenSseStreamCount()).toBe(1);

    await reader.cancel();
    await Bun.sleep(0);

    expect(runtime.getOpenSseStreamCount()).toBe(0);
  });

  test("streams run connection events", async () => {
    const { app, runtime } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const runId = await createRun(app);

    const response = await app.request(`http://localhost/runs/${runId}/event`);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-Id")).toBeDefined();

    const body = response.body;
    expect(body).not.toBeNull();
    if (!body) {
      return;
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();

    const firstChunk = await reader.read();
    const firstPayload = firstChunk.value ? decoder.decode(firstChunk.value) : "";
    expect(firstPayload).toContain("event: run.connected");
    expect(firstPayload).toContain(runId);

    runtime.closeSseStreams("test-shutdown");
    await reader.cancel();
  });
});
