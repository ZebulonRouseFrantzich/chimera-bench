import { describe, expect, test } from "bun:test";
import {
  buildApp,
  TEST_MODEL_IDENTIFIER,
} from "./helpers/app-fixture.ts";

describe("observability", () => {
  test("emits access logs with requestId in dev mode", async () => {
    const logLines: string[] = [];
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      devMode: true,
      logger: createTestLogger(logLines),
    });

    const response = await app.request("http://localhost/global/health");
    expect(response.status).toBe(200);

    const payload = await response.json();
    const requestId = payload.meta?.requestId;
    expect(typeof requestId).toBe("string");
    if (typeof requestId !== "string") {
      throw new Error("Expected health response to include meta.requestId.");
    }

    expect(
      logLines.some((line) => {
        return (
          line.includes(`requestId=${requestId}`) &&
          line.includes('method="GET"') &&
          line.includes('path="/global/health"') &&
          line.includes("status=200")
        );
      }),
    ).toBe(true);
  });

  test("logs run creation with requestId and runId", async () => {
    const logLines: string[] = [];
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      logger: createTestLogger(logLines),
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
    expect(response.status).toBe(202);

    const payload = await response.json();
    const requestId = payload.meta?.requestId;
    const runId = payload.data?.runId;

    expect(typeof requestId).toBe("string");
    expect(typeof runId).toBe("string");
    if (typeof requestId !== "string" || typeof runId !== "string") {
      throw new Error("Expected run creation payload to include requestId and runId.");
    }

    expect(
      logLines.some((line) => {
        return (
          line.includes("event=run.created") &&
          line.includes(`requestId=${requestId}`) &&
          line.includes(`runId=${runId}`)
        );
      }),
    ).toBe(true);
  });
});

function createTestLogger(logLines: string[]): {
  info(message: string): void;
  error(message: string): void;
} {
  return {
    info(message: string): void {
      logLines.push(message);
    },
    error(message: string): void {
      logLines.push(message);
    },
  };
}
