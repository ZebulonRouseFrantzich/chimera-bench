import { describe, expect, test } from "bun:test";
import { InMemoryRunStore } from "../src/server/runs/in-memory-run-store.ts";

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
});
