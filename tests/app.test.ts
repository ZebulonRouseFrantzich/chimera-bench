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
    expect(payload.healthy).toBe(true);
    expect(payload.version).toBe("0.1.0");
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

    runtime.closeSseStreams("test-shutdown");

    const secondChunk = await reader.read();
    const secondPayload = secondChunk.value ? decoder.decode(secondChunk.value) : "";
    expect(secondChunk.done || secondPayload.includes("event: server.disconnected")).toBe(
      true,
    );

    await reader.cancel();
  });
});
