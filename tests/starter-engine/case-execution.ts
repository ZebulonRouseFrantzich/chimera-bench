import { describe, expect, test } from "bun:test";
import {
  createContext,
  createRunConfig,
  createStarterLlamaCppPlugin,
  FakeChildProcess,
  TEST_API_KEY,
} from "./helpers.ts";

function createCaseConfig(prompt = "hello") {
  return {
    caseId: "case-1",
    index: 0,
    promptId: "prompt-1",
    prompt,
    messages: [
      {
        role: "user" as const,
        content: prompt,
      },
    ],
    requestParams: {
      max_tokens: 8,
    },
  };
}

describe("starter llama.cpp plugin case execution", () => {
  test("executeCase calls /v1/chat/completions and returns assistant output", async () => {
    const processHandle = new FakeChildProcess(62004);
    const observedRequests: Array<{
      url: string;
      init?: RequestInit;
    }> = [];

    const plugin = createStarterLlamaCppPlugin({
      allocateLoopbackPort: async () => 43141,
      createApiKey: () => TEST_API_KEY,
      startupProbeWindowMs: 5,
      spawnProcess: () => processHandle.asChildProcess(),
      fetch: async (url, init) => {
        if (url.endsWith("/health")) {
          return new Response("ok", {
            status: 200,
          });
        }

        observedRequests.push(
          init
            ? {
                url,
                init,
              }
            : {
                url,
              },
        );

        return new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "generated output text",
                },
              },
            ],
          }),
          {
            status: 200,
          },
        );
      },
      signalProcessGroup: (_pid, signal) => {
        if (signal === "SIGTERM") {
          processHandle.emitExit(0, null);
        }
      },
    });

    const launchConfig = await plugin.buildLaunchConfig(createRunConfig());
    const context = createContext("run_execute_case_success", launchConfig);

    await plugin.start(context);
    await plugin.waitUntilReady(context);
    const caseResult = await plugin.executeCase(context, {
      ...createCaseConfig("What is 2 + 2?"),
      requestParams: {
        max_tokens: 16,
        temperature: 0,
        model: "ignored-model",
        stream: true,
      },
    });

    expect(caseResult.outputText).toBe("generated output text");
    expect(observedRequests).toHaveLength(1);
    expect(observedRequests[0]?.url).toBe("http://127.0.0.1:43141/v1/chat/completions");
    expect(observedRequests[0]?.init?.method).toBe("POST");

    const requestHeaders = new Headers(observedRequests[0]?.init?.headers);
    expect(requestHeaders.get("authorization")).toBe(`Bearer ${TEST_API_KEY}`);
    expect(requestHeaders.get("content-type")).toBe("application/json");

    const requestBody = JSON.parse(String(observedRequests[0]?.init?.body));
    expect(requestBody.messages).toEqual([
      {
        role: "user",
        content: "What is 2 + 2?",
      },
    ]);
    expect(requestBody.model).toBeUndefined();
    expect(requestBody.stream).toBe(false);
    expect(requestBody.max_tokens).toBe(16);
    expect(requestBody.temperature).toBe(0);

    await plugin.stop(context);
  });

  test("executeCase surfaces ENGINE_EXECUTION_FAILED on non-2xx responses", async () => {
    const processHandle = new FakeChildProcess(62005);

    const plugin = createStarterLlamaCppPlugin({
      allocateLoopbackPort: async () => 43142,
      createApiKey: () => TEST_API_KEY,
      startupProbeWindowMs: 5,
      spawnProcess: () => processHandle.asChildProcess(),
      fetch: async (url) => {
        if (url.endsWith("/health")) {
          return new Response("ok", {
            status: 200,
          });
        }

        return new Response("engine overloaded", {
          status: 503,
        });
      },
      signalProcessGroup: (_pid, signal) => {
        if (signal === "SIGTERM") {
          processHandle.emitExit(0, null);
        }
      },
    });

    const launchConfig = await plugin.buildLaunchConfig(createRunConfig());
    const context = createContext("run_execute_case_non_2xx", launchConfig);

    await plugin.start(context);
    await plugin.waitUntilReady(context);
    await expect(plugin.executeCase(context, createCaseConfig())).rejects.toMatchObject({
      code: "ENGINE_EXECUTION_FAILED",
    });

    await plugin.stop(context);
  });

  test("executeCase surfaces ENGINE_EXECUTION_FAILED on invalid JSON", async () => {
    const processHandle = new FakeChildProcess(62006);

    const plugin = createStarterLlamaCppPlugin({
      allocateLoopbackPort: async () => 43143,
      createApiKey: () => TEST_API_KEY,
      startupProbeWindowMs: 5,
      spawnProcess: () => processHandle.asChildProcess(),
      fetch: async (url) => {
        if (url.endsWith("/health")) {
          return new Response("ok", {
            status: 200,
          });
        }

        return new Response("not-json", {
          status: 200,
        });
      },
      signalProcessGroup: (_pid, signal) => {
        if (signal === "SIGTERM") {
          processHandle.emitExit(0, null);
        }
      },
    });

    const launchConfig = await plugin.buildLaunchConfig(createRunConfig());
    const context = createContext("run_execute_case_invalid_json", launchConfig);

    await plugin.start(context);
    await plugin.waitUntilReady(context);
    await expect(plugin.executeCase(context, createCaseConfig())).rejects.toMatchObject({
      code: "ENGINE_EXECUTION_FAILED",
    });

    await plugin.stop(context);
  });

  test("executeCase surfaces ENGINE_EXECUTION_FAILED when response exceeds size limit", async () => {
    const processHandle = new FakeChildProcess(62007);

    const plugin = createStarterLlamaCppPlugin({
      allocateLoopbackPort: async () => 43144,
      createApiKey: () => TEST_API_KEY,
      startupProbeWindowMs: 5,
      maxCaseResponseBytes: 32,
      spawnProcess: () => processHandle.asChildProcess(),
      fetch: async (url) => {
        if (url.endsWith("/health")) {
          return new Response("ok", {
            status: 200,
          });
        }

        return new Response("x".repeat(256), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        });
      },
      signalProcessGroup: (_pid, signal) => {
        if (signal === "SIGTERM") {
          processHandle.emitExit(0, null);
        }
      },
    });

    const launchConfig = await plugin.buildLaunchConfig(createRunConfig());
    const context = createContext("run_execute_case_response_too_large", launchConfig);

    await plugin.start(context);
    await plugin.waitUntilReady(context);
    await expect(plugin.executeCase(context, createCaseConfig())).rejects.toMatchObject({
      code: "ENGINE_EXECUTION_FAILED",
      message: expect.stringContaining("exceeded"),
    });

    await plugin.stop(context);
  });

  test("executeCase surfaces ENGINE_EXECUTION_FAILED when fetch throws", async () => {
    const processHandle = new FakeChildProcess(62008);

    const plugin = createStarterLlamaCppPlugin({
      allocateLoopbackPort: async () => 43145,
      createApiKey: () => TEST_API_KEY,
      startupProbeWindowMs: 5,
      spawnProcess: () => processHandle.asChildProcess(),
      fetch: async (url) => {
        if (url.endsWith("/health")) {
          return new Response("ok", {
            status: 200,
          });
        }

        throw new Error("connect ECONNREFUSED 127.0.0.1:43145");
      },
      signalProcessGroup: (_pid, signal) => {
        if (signal === "SIGTERM") {
          processHandle.emitExit(0, null);
        }
      },
    });

    const launchConfig = await plugin.buildLaunchConfig(createRunConfig());
    const context = createContext("run_execute_case_fetch_throw", launchConfig);

    await plugin.start(context);
    await plugin.waitUntilReady(context);
    await expect(plugin.executeCase(context, createCaseConfig())).rejects.toMatchObject({
      code: "ENGINE_EXECUTION_FAILED",
    });

    await plugin.stop(context);
  });

  test("executeCase rethrows AbortError from fetch", async () => {
    const processHandle = new FakeChildProcess(62009);
    const abortError = new Error("synthetic abort");
    abortError.name = "AbortError";

    const plugin = createStarterLlamaCppPlugin({
      allocateLoopbackPort: async () => 43146,
      createApiKey: () => TEST_API_KEY,
      startupProbeWindowMs: 5,
      spawnProcess: () => processHandle.asChildProcess(),
      fetch: async (url) => {
        if (url.endsWith("/health")) {
          return new Response("ok", {
            status: 200,
          });
        }

        throw abortError;
      },
      signalProcessGroup: (_pid, signal) => {
        if (signal === "SIGTERM") {
          processHandle.emitExit(0, null);
        }
      },
    });

    const launchConfig = await plugin.buildLaunchConfig(createRunConfig());
    const context = createContext("run_execute_case_fetch_abort", launchConfig);

    await plugin.start(context);
    await plugin.waitUntilReady(context);
    await expect(plugin.executeCase(context, createCaseConfig())).rejects.toBe(abortError);

    await plugin.stop(context);
  });

  test("executeCase surfaces ENGINE_EXECUTION_FAILED when assistant output is missing", async () => {
    const processHandle = new FakeChildProcess(62010);

    const plugin = createStarterLlamaCppPlugin({
      allocateLoopbackPort: async () => 43147,
      createApiKey: () => TEST_API_KEY,
      startupProbeWindowMs: 5,
      spawnProcess: () => processHandle.asChildProcess(),
      fetch: async (url) => {
        if (url.endsWith("/health")) {
          return new Response("ok", {
            status: 200,
          });
        }

        return new Response(
          JSON.stringify({
            id: "chatcmpl-2",
            choices: [],
          }),
          {
            status: 200,
          },
        );
      },
      signalProcessGroup: (_pid, signal) => {
        if (signal === "SIGTERM") {
          processHandle.emitExit(0, null);
        }
      },
    });

    const launchConfig = await plugin.buildLaunchConfig(createRunConfig());
    const context = createContext("run_execute_case_missing_output", launchConfig);

    await plugin.start(context);
    await plugin.waitUntilReady(context);
    await expect(plugin.executeCase(context, createCaseConfig())).rejects.toMatchObject({
      code: "ENGINE_EXECUTION_FAILED",
    });

    await plugin.stop(context);
  });
});
