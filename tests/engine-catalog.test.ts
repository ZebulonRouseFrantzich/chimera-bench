import { describe, expect, test } from "bun:test";
import { createEngineCatalog } from "../src/server/engines/engine-catalog.ts";
import {
  ENGINE_PLUGIN_API_VERSION,
  type EnginePlugin,
} from "../src/server/engines/engine-plugin.ts";

describe("engine catalog", () => {
  test("resolves plugins by id", () => {
    const plugin = createPlugin({ id: "llama-cpp" });
    const catalog = createEngineCatalog([plugin]);

    expect(catalog.getById("llama-cpp")).toBe(plugin);
    expect(catalog.getById("missing")).toBeUndefined();
  });

  test("rejects duplicate plugin ids", () => {
    expect(() =>
      createEngineCatalog([
        createPlugin({ id: "llama-cpp" }),
        createPlugin({ id: "llama-cpp" }),
      ]),
    ).toThrow("registered more than once");
  });

  test("rejects invalid plugin ids", () => {
    expect(() => createEngineCatalog([createPlugin({ id: "bad id" })])).toThrow(
      "is invalid",
    );
  });

  test("rejects incompatible plugin api versions", () => {
    expect(() =>
      createEngineCatalog([
        createPlugin({
          id: "llama-cpp",
          apiVersion: (ENGINE_PLUGIN_API_VERSION + 1) as typeof ENGINE_PLUGIN_API_VERSION,
        }),
      ]),
    ).toThrow("targets API version");
  });

  test("returns a defensive list copy", () => {
    const plugin = createPlugin({ id: "llama-cpp" });
    const catalog = createEngineCatalog([plugin]);

    const firstList = catalog.list() as EnginePlugin[];
    firstList.push(createPlugin({ id: "vllm" }));

    const secondList = catalog.list();
    expect(secondList).toHaveLength(1);
    expect(secondList[0]?.id).toBe("llama-cpp");
  });
});

function createPlugin(overrides: Partial<EnginePlugin>): EnginePlugin {
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
