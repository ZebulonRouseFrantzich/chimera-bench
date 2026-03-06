import { describe, expect, test } from "bun:test";
import { buildApp } from "./helpers/app-fixture.ts";

describe("global routes", () => {
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
    expect(payload.data.version).toBe("0.0.3");
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
    expect(payload.paths["/targets"]).toBeDefined();
    expect(payload.paths["/runs"]).toBeDefined();
  });
});
