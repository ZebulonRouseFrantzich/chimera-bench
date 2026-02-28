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
    expect(payload.data.engines[0].environment.message).toContain("llama-server");
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
      streaming: true,
    },
    validateEnvironment: async () => ({
      status: "ok",
    }),
    validateRunConfig: async (runConfig) => ({
      ok: true,
      normalized: {
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
