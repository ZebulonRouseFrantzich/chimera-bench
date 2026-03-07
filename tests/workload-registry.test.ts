import { describe, expect, test } from "bun:test";
import {
  WorkloadInitialLoadBackoffError,
  WorkloadRegistry,
} from "../src/server/workloads/registry.ts";

describe("WorkloadRegistry", () => {
  test("backs off repeated startup scans after an initialization failure", async () => {
    let nowMs = 1_000;
    let startupScanAttempts = 0;

    const registry = new WorkloadRegistry({
      workloadRoots: [],
      now: () => nowMs,
      initialLoadFailureBackoffMs: 500,
      logger: {
        info(message: string): void {
          if (message.includes("event=workloads.scan trigger=startup")) {
            startupScanAttempts += 1;
            throw new Error("synthetic startup scan failure");
          }
        },
        error(_message: string): void {},
      },
    });

    await expect(registry.listSummaries()).rejects.toThrow("synthetic startup scan failure");
    expect(startupScanAttempts).toBe(1);

    const cooldownError = await registry
      .listSummaries()
      .catch((error: unknown) => error as Error);
    expect(cooldownError).toBeInstanceOf(WorkloadInitialLoadBackoffError);
    expect(startupScanAttempts).toBe(1);

    nowMs += 500;

    await expect(registry.listSummaries()).rejects.toThrow("synthetic startup scan failure");
    expect(startupScanAttempts).toBe(2);
  });
});
