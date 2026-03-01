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

  test("auto-closes run event stream after terminal replay events", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const runId = await createRun(app);
    await waitForTerminalRunStatus(app, runId);

    const response = await app.request(`http://localhost/runs/${runId}/event`);
    expect(response.status).toBe(200);

    const body = response.body;
    expect(body).not.toBeNull();
    if (!body) {
      return;
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let payload = "";

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const chunk = await reader.read();
      if (chunk.value) {
        payload += decoder.decode(chunk.value);
      }

      if (chunk.done) {
        break;
      }
    }

    expect(payload).toContain("event: run.connected");
    expect(
      payload.includes("event: run.completed") ||
        payload.includes("event: run.failed") ||
        payload.includes("event: run.cancelled"),
    ).toBe(true);
    expect(payload).toContain("event: run.disconnected");
    expect(payload).toContain('"reason":"run-terminal"');
    await reader.cancel();
  });
});

async function waitForTerminalRunStatus(
  app: ReturnType<typeof buildApp>["app"],
  runId: string,
): Promise<void> {
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
      return;
    }

    await Bun.sleep(10);
  }

  throw new Error(`Run '${runId}' did not reach a terminal status in time.`);
}
