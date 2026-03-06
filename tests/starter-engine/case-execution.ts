import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  createContext,
  createRunConfig,
  createStarterLlamaCppPlugin,
  FakeChildProcess,
  TEST_API_KEY,
  TEST_MODEL_IDENTIFIER,
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
    const observedChatRequests: Array<{
      url: string;
      init?: RequestInit;
    }> = [];
    const observedTokenizeRequests: Array<{
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

        if (url.endsWith("/tokenize")) {
          observedTokenizeRequests.push(
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
              tokens: [1, 2, 3],
            }),
            {
              status: 200,
            },
          );
        }

        observedChatRequests.push(
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
            object: "chat.completion",
            created: 1_700_000_000,
            model: TEST_MODEL_IDENTIFIER,
            system_fingerprint: "fp-test",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: "generated output text",
                },
              },
            ],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 7,
              total_tokens: 19,
            },
            internal_debug_token: "secret-should-not-persist",
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

    const launchConfig = await plugin.buildLaunchConfig(
      createRunConfig({
        serverArgs: ["--ctx-size", "4096"],
      }),
    );
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
    const sanitizedRawResponse = caseResult.rawResponse as Record<string, unknown>;
    expect(sanitizedRawResponse.internal_debug_token).toBeUndefined();
    expect(sanitizedRawResponse.object).toBe("chat.completion");
    expect(
      (sanitizedRawResponse.usage as Record<string, unknown> | undefined)?.completion_tokens,
    ).toBe(7);
    expect(observedTokenizeRequests).toHaveLength(1);
    expect(observedTokenizeRequests[0]?.url).toBe("http://127.0.0.1:43141/tokenize");
    expect(observedChatRequests).toHaveLength(1);
    expect(observedChatRequests[0]?.url).toBe("http://127.0.0.1:43141/v1/chat/completions");
    expect(observedChatRequests[0]?.init?.method).toBe("POST");

    const requestHeaders = new Headers(observedChatRequests[0]?.init?.headers);
    expect(requestHeaders.get("authorization")).toBe(`Bearer ${TEST_API_KEY}`);
    expect(requestHeaders.get("content-type")).toBe("application/json");

    const requestBody = JSON.parse(String(observedChatRequests[0]?.init?.body));
    expect(requestBody.messages).toEqual([
      {
        role: "user",
        content: "What is 2 + 2?",
      },
    ]);
    expect(requestBody.model).toBe(resolve(TEST_MODEL_IDENTIFIER));
    expect(requestBody.stream).toBe(false);
    expect(requestBody.max_tokens).toBe(16);
    expect(requestBody.temperature).toBe(0);

    await plugin.stop(context);
  });

  test("executeCase fails preflight when prompt exceeds configured ctx-size", async () => {
    const processHandle = new FakeChildProcess(62011);
    let chatRequestCount = 0;

    const plugin = createStarterLlamaCppPlugin({
      allocateLoopbackPort: async () => 43148,
      createApiKey: () => TEST_API_KEY,
      startupProbeWindowMs: 5,
      spawnProcess: () => processHandle.asChildProcess(),
      fetch: async (url) => {
        if (url.endsWith("/health")) {
          return new Response("ok", {
            status: 200,
          });
        }

        if (url.endsWith("/tokenize")) {
          return new Response(
            JSON.stringify({
              tokens: Array.from({ length: 2_000 }, (_, index) => {
                return index;
              }),
            }),
            {
              status: 200,
            },
          );
        }

        chatRequestCount += 1;
        return new Response(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: "unexpected",
            },
          }],
        }), {
          status: 200,
        });
      },
      signalProcessGroup: (_pid, signal) => {
        if (signal === "SIGTERM") {
          processHandle.emitExit(0, null);
        }
      },
    });

    const launchConfig = await plugin.buildLaunchConfig(
      createRunConfig({
        serverArgs: ["--ctx-size", "256"],
      }),
    );
    const context = createContext("run_execute_case_prompt_too_large", launchConfig);

    await plugin.start(context);
    await plugin.waitUntilReady(context);
    await expect(plugin.executeCase(context, createCaseConfig())).rejects.toMatchObject({
      code: "VALIDATION_PROMPT_TOO_LARGE",
      message: expect.stringContaining("--ctx-size"),
    });
    expect(chatRequestCount).toBe(0);

    await plugin.stop(context);
  });

  test("executeCase logs prompt preflight skip only once when ctx-size is unset", async () => {
    const processHandle = new FakeChildProcess(62013);
    const diagnostics: Array<{ level: string; message: string }> = [];

    const plugin = createStarterLlamaCppPlugin({
      allocateLoopbackPort: async () => 43150,
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
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "ok",
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
    const context = createContext("run_execute_case_preflight_skip_logged_once", launchConfig);
    context.emitDiagnostic = (diagnostic) => {
      diagnostics.push({
        level: diagnostic.level,
        message: diagnostic.message,
      });
    };

    await plugin.start(context);
    await plugin.waitUntilReady(context);
    await plugin.executeCase(context, createCaseConfig("first"));
    await plugin.executeCase(context, createCaseConfig("second"));

    const preflightSkipDiagnostics = diagnostics.filter((entry) => {
      return entry.message.includes("Skipping prompt token preflight");
    });
    expect(preflightSkipDiagnostics).toHaveLength(1);

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

  test("executeCase maps context-overflow 400 responses to VALIDATION_PROMPT_TOO_LARGE", async () => {
    const processHandle = new FakeChildProcess(62012);

    const plugin = createStarterLlamaCppPlugin({
      allocateLoopbackPort: async () => 43149,
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
            error: {
              type: "exceed_context_size_error",
              message: "request (40849 tokens) exceeds the available context size (4096)",
              n_prompt_tokens: 40849,
              n_ctx: 4096,
            },
          }),
          {
            status: 400,
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
    const context = createContext("run_execute_case_prompt_too_large_400", launchConfig);

    await plugin.start(context);
    await plugin.waitUntilReady(context);
    await expect(plugin.executeCase(context, createCaseConfig())).rejects.toMatchObject({
      code: "VALIDATION_PROMPT_TOO_LARGE",
      details: {
        promptCount: 40849,
        contextWindow: 4096,
      },
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
