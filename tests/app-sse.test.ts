import { describe, expect, test } from "bun:test";
import { buildApp, createRun } from "./helpers/app-fixture.ts";

describe("SSE routes", () => {
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
