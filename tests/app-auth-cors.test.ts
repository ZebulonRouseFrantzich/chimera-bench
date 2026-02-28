import { describe, expect, test } from "bun:test";
import { buildApp, createBasicAuthorization } from "./helpers/app-fixture.ts";

describe("auth and CORS middleware", () => {
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

    const authorized = await app.request("http://localhost/global/health", {
      headers: {
        Authorization: createBasicAuthorization(),
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

    const docsAuthorized = await app.request("http://localhost/doc", {
      headers: {
        Authorization: createBasicAuthorization(),
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
});
