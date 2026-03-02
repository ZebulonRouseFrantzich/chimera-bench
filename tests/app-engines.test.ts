import { describe, expect, test } from "bun:test";
import { createEngineCatalog } from "../src/server/engines/engine-catalog.ts";
import {
  ENGINE_PLUGIN_API_VERSION,
  type EnginePlugin,
} from "../src/server/engines/engine-plugin.ts";
import { buildApp } from "./helpers/app-fixture.ts";

describe("engine routes", () => {
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
    expect(payload.data.engines[0].capabilities.sshTarget).toBe(true);
  });

  test("returns error summary when environment validation throws", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          validateEnvironment: async () => {
            throw new Error("llama-server missing");
          },
        }),
      ]),
    });

    const response = await app.request("http://localhost/engines");
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.success).toBe(true);
    expect(payload.data.engines[0].environment.status).toBe("error");
    expect(payload.data.engines[0].environment.message).toContain("llama-cpp");
    expect(payload.data.engines[0].environment.message).toContain("Check server logs");
  });

  test("caches environment validation summaries for a short ttl", async () => {
    let validationCalls = 0;

    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          validateEnvironment: async () => {
            validationCalls += 1;
            return {
              status: "ok",
            };
          },
        }),
      ]),
    });

    const firstResponse = await app.request("http://localhost/engines");
    const secondResponse = await app.request("http://localhost/engines");

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(validationCalls).toBe(1);
  });

  test("re-validates environment once cache ttl expires", async () => {
    let validationCalls = 0;
    let nowMs = 100;

    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engineEnvironmentValidation: {
        successCacheTtlMs: 25,
        now: () => nowMs,
      },
      engines: createEngineCatalog([
        createTestPlugin({
          validateEnvironment: async () => {
            validationCalls += 1;
            return {
              status: "ok",
            };
          },
        }),
      ]),
    });

    const firstResponse = await app.request("http://localhost/engines");
    expect(firstResponse.status).toBe(200);
    expect(validationCalls).toBe(1);

    nowMs += 26;

    const secondResponse = await app.request("http://localhost/engines");
    expect(secondResponse.status).toBe(200);
    expect(validationCalls).toBe(2);
  });

  test("uses shorter cache ttl for environment validation errors", async () => {
    let validationCalls = 0;
    let nowMs = 200;

    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engineEnvironmentValidation: {
        successCacheTtlMs: 200,
        errorCacheTtlMs: 20,
        now: () => nowMs,
      },
      engines: createEngineCatalog([
        createTestPlugin({
          validateEnvironment: async () => {
            validationCalls += 1;
            throw new Error("transient failure");
          },
        }),
      ]),
    });

    const firstResponse = await app.request("http://localhost/engines");
    const secondResponse = await app.request("http://localhost/engines");

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(validationCalls).toBe(1);

    nowMs += 21;

    const thirdResponse = await app.request("http://localhost/engines");
    expect(thirdResponse.status).toBe(200);
    expect(validationCalls).toBe(2);
  });

  test("deduplicates concurrent environment validations", async () => {
    let validationCalls = 0;

    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          validateEnvironment: async () => {
            validationCalls += 1;
            await new Promise((resolve) => setTimeout(resolve, 25));
            return {
              status: "ok",
            };
          },
        }),
      ]),
    });

    const [firstResponse, secondResponse] = await Promise.all([
      app.request("http://localhost/engines"),
      app.request("http://localhost/engines"),
    ]);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(validationCalls).toBe(1);
  });
});

function createTestPlugin(overrides: Partial<EnginePlugin>): EnginePlugin {
  return {
    apiVersion: ENGINE_PLUGIN_API_VERSION,
    id: "llama-cpp",
    displayName: "llama.cpp",
    version: "test",
    capabilities: {
      chatCompletions: true,
      localTarget: true,
      sshTarget: false,
      streaming: true,
    },
    validateEnvironment: async () => ({
      status: "ok",
    }),
    validateRunConfig: async (runConfig) => ({
      ok: true,
      normalized: {
        modelIdentifier: runConfig.model.identifier,
        serverArgs: [...runConfig.engine.serverArgs],
        requestParams: { ...runConfig.engine.requestParams },
      },
    }),
    buildLaunchConfig: async (runConfig) => ({
      command: "llama-server",
      args: [...runConfig.engine.serverArgs],
    }),
    start: async () => {
      return;
    },
    waitUntilReady: async () => {
      return;
    },
    executeCase: async () => ({
      outputText: "",
    }),
    collectMetrics: async () => ({}),
    stop: async () => {
      return;
    },
    ...overrides,
  };
}
