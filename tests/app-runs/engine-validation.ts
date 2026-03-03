import { describe, expect, test } from "bun:test";
import { createEngineCatalog } from "../../src/server/engines/engine-catalog.ts";
import { buildApp, createTestPlugin } from "./helpers.ts";

describe("run routes", () => {
  test("maps plugin validation errors to 400 responses", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          validateRunConfig: async () => ({
            ok: false,
            code: "VALIDATION_ENGINE_OPTIONS_INVALID",
            message: "Unsafe server arguments were supplied.",
            issues: [
              {
                code: "SERVER_ARG_RESERVED",
                message: "--port is reserved.",
                path: "engine.serverArgs[0]",
              },
            ],
          }),
        }),
      ]),
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
          serverArgs: ["--port=1234"],
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_ENGINE_OPTIONS_INVALID");
    expect(payload.error.details.issues[0].code).toBe("SERVER_ARG_RESERVED");
  });

  test("sanitizes plugin issue code and path values", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          validateRunConfig: async () => ({
            ok: false,
            code: "validation\nengine\u0000options",
            message: "Unsafe options.",
            issues: [
              {
                code: "server\narg",
                message: "bad arg",
                path: "engine.serverArgs[0]\ncontrol",
              },
            ],
          }),
        }),
      ]),
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
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_ENGINE_OPTIONS");
    expect(payload.error.details.issues[0].code).toBe("SERVER_ARG");
    expect(payload.error.details.issues[0].path).toBe("engine.serverArgs[0] control");
  });

  test("reports actionable paths for default server argument validation", async () => {
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
          serverArgs: ["--port=1234"],
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_ENGINE_OPTIONS_INVALID");
    expect(payload.error.details.issues[0].code).toBe("SERVER_ARG_RESERVED");
    expect(payload.error.details.issues[0].path).toBe("engine.serverArgs[0]");
  });

  test("maps thrown plugin validation failures to 500 responses", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          validateRunConfig: async () => {
            throw new Error("Validation backend crashed");
          },
        }),
      ]),
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
      }),
    });

    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload.error.code).toBe("ENGINE_VALIDATION_FAILED");
  });
});
