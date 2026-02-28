import { describe, expect, test } from "bun:test";
import { InMemoryRunStore } from "../src/server/runs/in-memory-run-store.ts";

const RUN_INPUT = {
  engineId: "llama-cpp",
  modelIdentifier: "/tmp/model.gguf",
  workloadId: "starter.v1",
};

describe("InMemoryRunStore", () => {
  test("returns null when capacity is full with non-terminal runs", () => {
    const store = new InMemoryRunStore({
      maxTrackedRuns: 2,
    });

    const runA = store.tryCreateQueuedRun(RUN_INPUT);
    const runB = store.tryCreateQueuedRun(RUN_INPUT);
    const runC = store.tryCreateQueuedRun(RUN_INPUT);

    expect(runA).not.toBeNull();
    expect(runB).not.toBeNull();
    expect(runC).toBeNull();
  });

  test("evicts the oldest terminal run when creating at capacity", () => {
    const store = new InMemoryRunStore({
      maxTrackedRuns: 2,
    });

    const runA = store.tryCreateQueuedRun(RUN_INPUT);
    const runB = store.tryCreateQueuedRun(RUN_INPUT);

    expect(typeof runA).toBe("string");
    expect(typeof runB).toBe("string");
    if (!runA || !runB) {
      throw new Error("Expected initial runs to be created.");
    }

    const cancelledStatus = store.cancelRun(runA, new Date().toISOString());
    expect(cancelledStatus).toBe("cancelled");

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
});
