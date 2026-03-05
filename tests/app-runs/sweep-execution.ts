import { describe, expect, test } from "bun:test";
import { createEngineCatalog } from "../../src/server/engines/engine-catalog.ts";
import {
  buildSweepCaseConfigId,
  expandSweepCases,
} from "../../src/server/runs/sweep-expansion.ts";
import { getBuiltInWorkload } from "../../src/server/runs/starter-workload.ts";
import {
  buildApp,
  createTestPlugin,
  TEST_MODEL_IDENTIFIER,
  waitForCondition,
  waitForTerminalRunStatus,
} from "./helpers.ts";

function createSweepRequestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engineId: "llama-cpp",
    target: {
      type: "local",
    },
    model: {
      identifier: TEST_MODEL_IDENTIFIER,
    },
    workloadId: "tuning.v0_0_1",
    validationMode: "permissive",
    sweep: {
      axes: {
        serverArgs: {
          ctxSize: [["--ctx-size", "4096"], ["--ctx-size", "8192"]],
        },
        requestParams: {
          max_tokens: [128, 256],
        },
      },
      maxCases: 16,
      repetitions: 1,
    },
    ...overrides,
  };
}

async function createSweepRun(
  app: ReturnType<typeof buildApp>["app"],
  body: Record<string, unknown>,
): Promise<string> {
  const createResponse = await app.request("http://localhost/runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  expect(createResponse.status).toBe(202);
  const createPayload = await createResponse.json();
  const runId = createPayload.data?.runId;
  expect(typeof runId).toBe("string");
  if (typeof runId !== "string") {
    throw new Error("Expected sweep run creation to return a runId.");
  }

  return runId;
}

describe("run routes", () => {
  test("deterministic sweep expansion order uses sorted axis keys", async () => {
    const observedCaseIds: string[] = [];
    const observedLaunchArgs: string[][] = [];

    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          buildLaunchConfig: async (runConfig) => {
            observedLaunchArgs.push([...runConfig.engine.serverArgs]);
            return {
              command: "llama-server",
              args: [...runConfig.engine.serverArgs],
            };
          },
          executeCase: async (_context, caseConfig) => {
            observedCaseIds.push(caseConfig.caseId);
            return {
              outputText: `ok:${caseConfig.caseId}`,
            };
          },
        }),
      ]),
    });

    const sweep = {
      axes: {
        serverArgs: {
          zAxis: [["--n-gpu-layers", "0"], ["--n-gpu-layers", "33"]],
          aAxis: [["--ctx-size", "4096"], ["--ctx-size", "8192"]],
        },
        requestParams: {
          temperature: [0.1, 0.8],
          max_tokens: [128, 256],
        },
      },
      maxCases: 32,
      repetitions: 1,
    };

    const workload = getBuiltInWorkload("tuning.v0_0_1");
    if (!workload) {
      throw new Error("Expected tuning workload fixture.");
    }
    const workloadCase = workload.cases[0];
    if (!workloadCase) {
      throw new Error("Expected tuning workload to include one case.");
    }

    const expectedCases = expandSweepCases({
      engineId: "llama-cpp",
      modelIdentifier: TEST_MODEL_IDENTIFIER,
      workloadId: "tuning.v0_0_1",
      workloadCase,
      baseServerArgs: [],
      baseRequestParams: {},
      sweep,
    });

    const runId = await createSweepRun(
      app,
      createSweepRequestBody({
        sweep,
      }),
    );
    const status = await waitForTerminalRunStatus(app, runId);
    expect(status).toBe("completed");

    expect(observedCaseIds).toEqual(expectedCases.map((caseConfig) => caseConfig.caseId));
    expect(observedLaunchArgs).toEqual(
      expectedCases.map((caseConfig) => caseConfig.engineArgs),
    );
  });

  test("hash-based caseId remains stable for canonical sweep config", () => {
    const caseConfigId = buildSweepCaseConfigId({
      engineId: "llama-cpp",
      modelIdentifier: "/models/sample.gguf",
      workloadId: "tuning.v0_0_1",
      promptId: "tuning.v0_0_1.prompt-1",
      engineArgs: ["--ctx-size", "8192", "--n-gpu-layers", "33"],
      requestParams: {
        temperature: 0.8,
        max_tokens: 256,
        nested: {
          values: ["alpha", "beta", 3],
        },
      },
    });

    expect(caseConfigId).toBe(
      "sweep_9a400fd574783f036a8dba959220e12c2b3942f20c6d727c2fe0ba33067ed2db",
    );
  });

  test("caseId repetition suffixes are deterministic", () => {
    const workload = getBuiltInWorkload("tuning.v0_0_1");
    if (!workload) {
      throw new Error("Expected tuning workload fixture.");
    }
    const workloadCase = workload.cases[0];
    if (!workloadCase) {
      throw new Error("Expected tuning workload to include one case.");
    }

    const expanded = expandSweepCases({
      engineId: "llama-cpp",
      modelIdentifier: TEST_MODEL_IDENTIFIER,
      workloadId: "tuning.v0_0_1",
      workloadCase,
      baseServerArgs: [],
      baseRequestParams: {},
      sweep: {
        axes: {
          serverArgs: {
            ctxSize: [["--ctx-size", "4096"]],
          },
          requestParams: {},
        },
        maxCases: 8,
        repetitions: 2,
      },
    });

    expect(expanded).toHaveLength(2);
    expect(expanded[0]?.caseId.endsWith(".rep-1")).toBe(true);
    expect(expanded[1]?.caseId.endsWith(".rep-2")).toBe(true);
    expect(expanded[0]?.caseConfigId).toBe(expanded[1]?.caseConfigId);
  });

  test("sweep execution restarts engine per case and persists per-case config", async () => {
    let startCalls = 0;
    let readyCalls = 0;
    let stopCalls = 0;

    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          start: async () => {
            startCalls += 1;
          },
          waitUntilReady: async () => {
            readyCalls += 1;
          },
          stop: async () => {
            stopCalls += 1;
          },
          executeCase: async (_context, caseConfig) => {
            return {
              outputText: `ok:${caseConfig.caseId}`,
            };
          },
        }),
      ]),
    });

    const sweep = {
      axes: {
        serverArgs: {
          ctxSize: [["--ctx-size", "4096"], ["--ctx-size", "8192"]],
        },
        requestParams: {
          max_tokens: [64, 128],
        },
      },
      maxCases: 16,
      repetitions: 1,
    };

    const runId = await createSweepRun(
      app,
      createSweepRequestBody({
        sweep,
      }),
    );
    const status = await waitForTerminalRunStatus(app, runId);
    expect(status).toBe("completed");

    expect(startCalls).toBe(4);
    expect(readyCalls).toBe(4);
    expect(stopCalls).toBe(4);

    const resultResponse = await app.request(`http://localhost/runs/${runId}/result`);
    expect(resultResponse.status).toBe(200);
    const resultPayload = await resultResponse.json();

    expect(resultPayload.data.result.summary.totalCases).toBe(4);
    expect(resultPayload.data.result.cases).toHaveLength(4);

    const workload = getBuiltInWorkload("tuning.v0_0_1");
    if (!workload) {
      throw new Error("Expected tuning workload fixture.");
    }
    const workloadCase = workload.cases[0];
    if (!workloadCase) {
      throw new Error("Expected tuning workload to include one case.");
    }

    const expectedCases = expandSweepCases({
      engineId: "llama-cpp",
      modelIdentifier: TEST_MODEL_IDENTIFIER,
      workloadId: "tuning.v0_0_1",
      workloadCase,
      baseServerArgs: [],
      baseRequestParams: {},
      sweep,
    });

    expect(
      resultPayload.data.result.cases.map((caseOutcome: { caseId: string }) => {
        return caseOutcome.caseId;
      }),
    ).toEqual(
      expectedCases.map((caseConfig) => {
        return caseConfig.caseId;
      }),
    );
    expect(
      resultPayload.data.result.cases.map((caseOutcome: { engineArgs: string[] }) => {
        return caseOutcome.engineArgs;
      }),
    ).toEqual(
      expectedCases.map((caseConfig) => {
        return caseConfig.engineArgs;
      }),
    );
  });

  test("sweep per-case latency reflects executeCase time, not restart lifecycle time", async () => {
    const startupDelayMs = 1_000;
    const executeDelayMs = 20;

    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          start: async () => {
            await Bun.sleep(startupDelayMs);
          },
          waitUntilReady: async () => {
            await Bun.sleep(startupDelayMs);
          },
          executeCase: async () => {
            await Bun.sleep(executeDelayMs);
            return {
              outputText: "one two three four five six seven eight",
            };
          },
        }),
      ]),
    });

    const runId = await createSweepRun(
      app,
      createSweepRequestBody({
        sweep: {
          axes: {
            serverArgs: {
              ctxSize: [["--ctx-size", "4096"]],
            },
            requestParams: {
              max_tokens: [128],
            },
          },
          maxCases: 4,
          repetitions: 1,
        },
      }),
    );
    const status = await waitForTerminalRunStatus(app, runId);
    expect(status).toBe("completed");

    const resultResponse = await app.request(`http://localhost/runs/${runId}/result`);
    expect(resultResponse.status).toBe(200);
    const resultPayload = await resultResponse.json();
    const firstCase = resultPayload.data.result.cases[0] as {
      latencyMs?: unknown;
      tokensPerSecond?: unknown;
    };

    expect(typeof firstCase.latencyMs).toBe("number");
    if (typeof firstCase.latencyMs !== "number") {
      throw new Error("Expected first case latencyMs to be present.");
    }

    expect(firstCase.latencyMs).toBeGreaterThanOrEqual(executeDelayMs - 10);
    expect(firstCase.latencyMs).toBeLessThan(Math.floor(startupDelayMs / 2));

    expect(typeof firstCase.tokensPerSecond).toBe("number");
    if (typeof firstCase.tokensPerSecond !== "number") {
      throw new Error("Expected first case tokensPerSecond to be present.");
    }

    expect(firstCase.tokensPerSecond).toBeGreaterThan(0);
  });

  test("persists sweep ranking deterministically in result.json", async () => {
    const sweep = {
      axes: {
        serverArgs: {
          ctxSize: [["--ctx-size", "4096"], ["--ctx-size", "8192"]],
        },
        requestParams: {
          max_tokens: [64, 128],
        },
      },
      maxCases: 16,
      repetitions: 1,
    };

    const workload = getBuiltInWorkload("tuning.v0_0_1");
    if (!workload) {
      throw new Error("Expected tuning workload fixture.");
    }
    const workloadCase = workload.cases[0];
    if (!workloadCase) {
      throw new Error("Expected tuning workload to include one case.");
    }

    const expectedCases = expandSweepCases({
      engineId: "llama-cpp",
      modelIdentifier: TEST_MODEL_IDENTIFIER,
      workloadId: "tuning.v0_0_1",
      workloadCase,
      baseServerArgs: [],
      baseRequestParams: {},
      sweep,
    });
    expect(expectedCases).toHaveLength(4);

    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          executeCase: async (_context, caseConfig) => {
            if (caseConfig.index >= 2) {
              throw new Error(`synthetic case failure ${caseConfig.index}`);
            }

            await Bun.sleep(20);

            if (caseConfig.index === 0) {
              return {
                outputText: Array.from({ length: 100 }, () => {
                  return "token";
                }).join(" "),
              };
            }

            return {
              outputText: "token",
            };
          },
        }),
      ]),
    });

    const runId = await createSweepRun(
      app,
      createSweepRequestBody({
        sweep,
      }),
    );
    const status = await waitForTerminalRunStatus(app, runId);
    expect(status).toBe("completed");

    const resultResponse = await app.request(`http://localhost/runs/${runId}/result`);
    expect(resultResponse.status).toBe(200);
    const resultPayload = await resultResponse.json();
    expect(resultPayload.data?.result?.sweep).toBeDefined();

    const sweepResult = resultPayload.data.result.sweep as {
      axes: {
        serverArgs: Record<string, string[][]>;
        requestParams: Record<string, unknown[]>;
      };
      repetitions: number;
      maxCases: number;
      plannedCases: number;
      ranking: Array<
        | {
            rank: number;
            caseId: string;
            status: "completed";
            tokensPerSecond: number;
            latencyMs: number;
          }
        | {
            rank: number;
            caseId: string;
            status: "failed";
          }
      >;
    };

    expect(sweepResult.axes).toEqual(sweep.axes);
    expect(sweepResult.repetitions).toBe(1);
    expect(sweepResult.maxCases).toBe(16);
    expect(sweepResult.plannedCases).toBe(4);
    expect(sweepResult.ranking).toHaveLength(4);
    expect(
      sweepResult.ranking.map((entry) => {
        return entry.rank;
      }),
    ).toEqual([1, 2, 3, 4]);

    const firstExpectedCase = expectedCases[0];
    const secondExpectedCase = expectedCases[1];
    const thirdExpectedCase = expectedCases[2];
    const fourthExpectedCase = expectedCases[3];
    if (!firstExpectedCase || !secondExpectedCase || !thirdExpectedCase || !fourthExpectedCase) {
      throw new Error("Expected four expanded sweep cases.");
    }

    expect(sweepResult.ranking[0]?.caseId).toBe(firstExpectedCase.caseId);
    expect(sweepResult.ranking[0]?.status).toBe("completed");
    expect(sweepResult.ranking[1]?.caseId).toBe(secondExpectedCase.caseId);
    expect(sweepResult.ranking[1]?.status).toBe("completed");

    const failedCaseIds = [thirdExpectedCase.caseId, fourthExpectedCase.caseId].sort();
    expect(
      sweepResult.ranking.slice(2).map((entry) => {
        return entry.caseId;
      }),
    ).toEqual(failedCaseIds);
    expect(sweepResult.ranking[2]?.status).toBe("failed");
    expect(sweepResult.ranking[3]?.status).toBe("failed");

    const firstRankingEntry = sweepResult.ranking[0];
    if (!firstRankingEntry || firstRankingEntry.status !== "completed") {
      throw new Error("Expected first ranking entry to be completed.");
    }

    expect(typeof firstRankingEntry.tokensPerSecond).toBe("number");
    expect(typeof firstRankingEntry.latencyMs).toBe("number");
    const thirdRankingEntry = sweepResult.ranking[2];
    expect(thirdRankingEntry && "tokensPerSecond" in thirdRankingEntry).toBe(false);
  });

  test("sweep cancel stops active case without starting the next case", async () => {
    let startCalls = 0;
    let stopCalls = 0;
    let executeCalls = 0;

    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          start: async () => {
            startCalls += 1;
          },
          stop: async () => {
            stopCalls += 1;
          },
          executeCase: async (context) => {
            executeCalls += 1;
            return await new Promise((_, reject) => {
              context.abortSignal.addEventListener(
                "abort",
                () => {
                  const abortError = new Error("Aborted");
                  abortError.name = "AbortError";
                  reject(abortError);
                },
                {
                  once: true,
                },
              );
            });
          },
        }),
      ]),
    });

    const runId = await createSweepRun(
      app,
      createSweepRequestBody({
        sweep: {
          axes: {
            serverArgs: {
              ctxSize: [["--ctx-size", "4096"], ["--ctx-size", "8192"]],
            },
            requestParams: {
              max_tokens: [64, 128],
            },
          },
          maxCases: 16,
          repetitions: 1,
        },
      }),
    );

    await waitForCondition(() => {
      return executeCalls > 0;
    });

    const cancelResponse = await app.request(`http://localhost/runs/${runId}/cancel`, {
      method: "POST",
    });
    expect(cancelResponse.status).toBe(200);
    const cancelPayload = await cancelResponse.json();
    expect(cancelPayload.data.status).toBe("cancelled");

    const status = await waitForTerminalRunStatus(app, runId);
    expect(status).toBe("cancelled");

    expect(startCalls).toBe(1);
    expect(executeCalls).toBe(1);
    expect(stopCalls).toBeGreaterThanOrEqual(1);
  });

  test("fails run after three consecutive engine lifecycle failures", async () => {
    let startCalls = 0;

    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          start: async () => {
            startCalls += 1;
            const startupError = new Error("synthetic startup failure") as Error & {
              code: string;
            };
            startupError.code = "ENGINE_START_FAILED";
            throw startupError;
          },
        }),
      ]),
    });

    const runId = await createSweepRun(app, createSweepRequestBody());
    const status = await waitForTerminalRunStatus(app, runId);
    expect(status).toBe("failed");
    expect(startCalls).toBe(3);

    const resultResponse = await app.request(`http://localhost/runs/${runId}/result`);
    expect(resultResponse.status).toBe(200);
    const resultPayload = await resultResponse.json();

    expect(resultPayload.data.result.summary.totalCases).toBe(4);
    expect(resultPayload.data.result.summary.failedCases).toBe(4);
    expect(resultPayload.data.result.error.code).toBe("ENGINE_START_FAILED");
  });

  test("marks sweep run failed with RUN_TIMEOUT_EXCEEDED when run deadline is exceeded", async () => {
    let startCalls = 0;

    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          start: async () => {
            startCalls += 1;
            await Bun.sleep(20);
          },
        }),
      ]),
    });

    const runId = await createSweepRun(
      app,
      createSweepRequestBody({
        sweep: {
          axes: {
            serverArgs: {
              ctxSize: [["--ctx-size", "4096"]],
            },
            requestParams: {
              max_tokens: [128],
            },
          },
          maxCases: 4,
          repetitions: 1,
        },
        timeouts: {
          runMs: 10,
        },
      }),
    );

    const status = await waitForTerminalRunStatus(app, runId);
    expect(status).toBe("failed");
    expect(startCalls).toBe(1);

    const resultResponse = await app.request(`http://localhost/runs/${runId}/result`);
    expect(resultResponse.status).toBe(200);
    const resultPayload = await resultResponse.json();

    expect(resultPayload.data.result.error.code).toBe("RUN_TIMEOUT_EXCEEDED");
    expect(resultPayload.data.result.summary.totalCases).toBe(1);
    expect(resultPayload.data.result.summary.failedCases).toBe(1);
  });
});
