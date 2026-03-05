import { describe, expect, test } from "bun:test";
import { InMemoryRunStore } from "../src/server/runs/in-memory-run-store/index.ts";

const RUN_INPUT = {
  engineId: "llama-cpp",
  modelIdentifier: "/tmp/model.gguf",
  workloadId: "starter.v1",
};

describe("InMemoryRunStore", () => {
  test("enforces single active run concurrency", () => {
    const store = new InMemoryRunStore({
      maxTrackedRuns: 2,
    });

    const runA = store.tryCreateQueuedRunDetailed(RUN_INPUT);
    const runB = store.tryCreateQueuedRunDetailed(RUN_INPUT);

    expect(runA.ok).toBe(true);
    expect(runB.ok).toBe(false);
    if (!runB.ok) {
      expect(runB.reason).toBe("concurrency");
    }
  });

  test("evicts the oldest terminal run when creating at capacity", () => {
    const store = new InMemoryRunStore({
      maxTrackedRuns: 2,
    });

    const runA = store.tryCreateQueuedRun(RUN_INPUT);

    expect(typeof runA).toBe("string");
    if (!runA) {
      throw new Error("Expected initial runs to be created.");
    }

    const cancelledStatus = store.cancelRun(runA, new Date().toISOString());
    expect(cancelledStatus).toBe("cancelled");

    const runB = store.tryCreateQueuedRun(RUN_INPUT);
    expect(typeof runB).toBe("string");
    if (!runB) {
      throw new Error("Expected second run to be created.");
    }

    const cancelledStatusB = store.cancelRun(runB, new Date().toISOString());
    expect(cancelledStatusB).toBe("cancelled");

    const runC = store.tryCreateQueuedRun(RUN_INPUT);
    expect(typeof runC).toBe("string");
    expect(store.hasRun(runA)).toBe(false);
    expect(store.hasRun(runB)).toBe(true);
  });

  test("stores cancelled stub results with cancelled status", () => {
    const store = new InMemoryRunStore();
    const runId = store.tryCreateQueuedRun(RUN_INPUT);

    expect(typeof runId).toBe("string");
    if (!runId) {
      throw new Error("Expected run to be created.");
    }

    const status = store.cancelRun(runId, new Date().toISOString());
    expect(status).toBe("cancelled");

    const result = store.getRunResult(runId);
    expect(result).toBeDefined();
    expect(result?.status).toBe("cancelled");
  });

  test("persists ssh targetProfileId in result artifacts", () => {
    const store = new InMemoryRunStore();
    const runId = store.tryCreateQueuedRun({
      ...RUN_INPUT,
      target: "ssh",
      targetProfileId: "lab",
    });

    expect(typeof runId).toBe("string");
    if (!runId) {
      throw new Error("Expected run to be created.");
    }

    const status = store.cancelRun(runId, new Date().toISOString());
    expect(status).toBe("cancelled");

    const result = store.getRunResult(runId);
    expect(result?.target).toBe("ssh");
    expect(result?.targetProfileId).toBe("lab");
  });

  test("builds deterministic sweep ranking for persisted results", () => {
    const store = new InMemoryRunStore();
    const runId = store.tryCreateQueuedRun({
      ...RUN_INPUT,
      sweep: {
        axes: {
          serverArgs: {
            ctxSize: [["--ctx-size", "4096"]],
          },
          requestParams: {
            max_tokens: [128],
          },
        },
        repetitions: 1,
        maxCases: 16,
        plannedCases: 5,
      },
      totalCases: 5,
    });

    expect(typeof runId).toBe("string");
    if (!runId) {
      throw new Error("Expected run to be created.");
    }

    store.markRunRunning(runId, new Date().toISOString());

    store.recordCaseCompleted(runId, {
      caseId: "case-a",
      promptId: "prompt-a",
      index: 0,
      contextTokens: 10,
      latencyMs: 100,
      outputText: "one two three four five six seven eight nine ten",
      engineArgs: ["--ctx-size", "4096"],
      requestParams: {
        max_tokens: 128,
      },
    });
    store.recordCaseCompleted(runId, {
      caseId: "case-c",
      promptId: "prompt-c",
      index: 1,
      contextTokens: 5,
      latencyMs: 50,
      outputText: "one two three four five",
      engineArgs: ["--ctx-size", "4096"],
      requestParams: {
        max_tokens: 128,
      },
    });
    store.recordCaseCompleted(runId, {
      caseId: "case-b",
      promptId: "prompt-b",
      index: 2,
      contextTokens: 5,
      latencyMs: 50,
      outputText: "one two three four five",
      engineArgs: ["--ctx-size", "4096"],
      requestParams: {
        max_tokens: 128,
      },
    });
    store.recordCaseFailed(runId, {
      caseId: "case-d",
      promptId: "prompt-d",
      index: 3,
      contextTokens: 1,
      latencyMs: 0,
      engineArgs: ["--ctx-size", "4096"],
      requestParams: {
        max_tokens: 128,
      },
      error: {
        code: "ENGINE_EXECUTION_FAILED",
        message: "synthetic failure",
      },
    });
    store.recordCaseFailed(runId, {
      caseId: "case-aa",
      promptId: "prompt-aa",
      index: 4,
      contextTokens: 1,
      latencyMs: 0,
      engineArgs: ["--ctx-size", "4096"],
      requestParams: {
        max_tokens: 128,
      },
      error: {
        code: "ENGINE_EXECUTION_FAILED",
        message: "synthetic failure",
      },
    });

    const status = store.completeRun(runId, new Date().toISOString());
    expect(status).toBe("completed");

    const result = store.getRunResult(runId) as {
      sweep?: {
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
    };

    expect(result.sweep?.repetitions).toBe(1);
    expect(result.sweep?.maxCases).toBe(16);
    expect(result.sweep?.plannedCases).toBe(5);
    expect(
      result.sweep?.ranking.map((entry) => {
        return entry.caseId;
      }),
    ).toEqual(["case-b", "case-c", "case-a", "case-aa", "case-d"]);
    expect(
      result.sweep?.ranking.map((entry) => {
        return entry.rank;
      }),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  test("persists empty sweep ranking when no case outcomes are recorded", () => {
    const store = new InMemoryRunStore();
    const runId = store.tryCreateQueuedRun({
      ...RUN_INPUT,
      sweep: {
        axes: {
          serverArgs: {
            ctxSize: [["--ctx-size", "4096"]],
          },
          requestParams: {
            max_tokens: [128],
          },
        },
        repetitions: 1,
        maxCases: 16,
        plannedCases: 1,
      },
      totalCases: 1,
    });

    expect(typeof runId).toBe("string");
    if (!runId) {
      throw new Error("Expected run to be created.");
    }

    store.markRunRunning(runId, new Date().toISOString());
    const status = store.completeRun(runId, new Date().toISOString());
    expect(status).toBe("completed");

    const result = store.getRunResult(runId) as {
      sweep?: {
        ranking?: unknown;
      };
    };

    expect(Array.isArray(result.sweep?.ranking)).toBe(true);
    expect(result.sweep?.ranking).toEqual([]);
  });

  test("uses completion_tokens from rawResponse when available", () => {
    const store = new InMemoryRunStore();
    const runId = store.tryCreateQueuedRun({
      ...RUN_INPUT,
      totalCases: 1,
    });

    expect(typeof runId).toBe("string");
    if (!runId) {
      throw new Error("Expected run to be created.");
    }

    store.markRunRunning(runId, new Date().toISOString());
    store.recordCaseCompleted(runId, {
      caseId: "case-usage",
      promptId: "prompt-usage",
      index: 0,
      contextTokens: 10,
      latencyMs: 84,
      outputText: "fallback text not used",
      engineArgs: [],
      requestParams: {},
      rawResponse: {
        usage: {
          completion_tokens: 42,
        },
      },
    });

    store.completeRun(runId, new Date().toISOString());

    const result = store.getRunResult(runId) as {
      cases?: Array<{
        outputTokens?: number;
        tokensPerSecond?: number;
      }>;
    } | null;
    const firstCase = result?.cases?.[0];
    expect(firstCase?.outputTokens).toBe(42);
    expect(firstCase?.tokensPerSecond).toBe(500);
  });

  test("prunes terminal runs that exceed retention window", () => {
    const store = new InMemoryRunStore({
      maxTrackedRuns: 1,
      terminalRunRetentionMs: 1000,
    });

    const runId = store.tryCreateQueuedRun(RUN_INPUT, 0);
    expect(typeof runId).toBe("string");
    if (!runId) {
      throw new Error("Expected run to be created.");
    }

    store.cancelRun(runId, new Date(0).toISOString());
    const nextRunId = store.tryCreateQueuedRun(RUN_INPUT, 2000);

    expect(typeof nextRunId).toBe("string");
    expect(store.hasRun(runId)).toBe(false);
  });

  test("uses injected clock values for createdAt timestamps", () => {
    const store = new InMemoryRunStore();
    const now = 1_700_000_000_000;
    const runId = store.tryCreateQueuedRun(RUN_INPUT, now);

    expect(typeof runId).toBe("string");
    if (!runId) {
      throw new Error("Expected run to be created.");
    }

    const summary = store.getRunSummary(runId);
    expect(summary?.createdAt).toBe(new Date(now).toISOString());
  });

  test("deep-clones failure details for persisted results", () => {
    const store = new InMemoryRunStore();
    const runId = store.tryCreateQueuedRun(RUN_INPUT);

    expect(typeof runId).toBe("string");
    if (!runId) {
      throw new Error("Expected run to be created.");
    }

    const details = {
      nested: {
        code: "initial",
      },
    };

    store.failRun(runId, new Date().toISOString(), {
      code: "RUN_CASE_FAILED",
      message: "Case failed",
      details,
    });

    details.nested.code = "mutated";

    const result = store.getRunResult(runId);
    const failureDetails = result?.error as
      | {
          details?: {
            nested?: {
              code?: string;
            };
          };
        }
      | undefined;
    expect(failureDetails?.details?.nested?.code).toBe("initial");
  });

  test("deep-clones nested requestParams for persisted case outcomes", () => {
    const store = new InMemoryRunStore();
    const runId = store.tryCreateQueuedRun({
      ...RUN_INPUT,
      totalCases: 2,
    });

    expect(typeof runId).toBe("string");
    if (!runId) {
      throw new Error("Expected run to be created.");
    }

    const completedRequestParams = {
      nested: {
        temperature: 0.2,
      },
    };
    const failedRequestParams = {
      nested: {
        max_tokens: 32,
      },
    };

    store.markRunRunning(runId, new Date().toISOString());

    store.recordCaseCompleted(runId, {
      caseId: "case-completed",
      promptId: "prompt-completed",
      index: 0,
      contextTokens: 10,
      latencyMs: 100,
      outputText: "hello world",
      engineArgs: [],
      requestParams: completedRequestParams,
    });

    store.recordCaseFailed(runId, {
      caseId: "case-failed",
      promptId: "prompt-failed",
      index: 1,
      contextTokens: 5,
      latencyMs: 0,
      engineArgs: [],
      requestParams: failedRequestParams,
      error: {
        code: "ENGINE_EXECUTION_FAILED",
        message: "synthetic failure",
      },
    });

    completedRequestParams.nested.temperature = 0.9;
    failedRequestParams.nested.max_tokens = 128;

    store.completeRun(runId, new Date().toISOString());

    const result = store.getRunResult(runId) as {
      cases?: Array<{
        requestParams?: {
          nested?: {
            temperature?: number;
            max_tokens?: number;
          };
        };
      }>;
    } | null;

    const completedCaseParams = result?.cases?.[0]?.requestParams;
    const failedCaseParams = result?.cases?.[1]?.requestParams;
    expect(completedCaseParams?.nested?.temperature).toBe(0.2);
    expect(failedCaseParams?.nested?.max_tokens).toBe(32);
  });
});
