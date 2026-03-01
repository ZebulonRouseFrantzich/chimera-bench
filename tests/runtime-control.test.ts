import { describe, expect, test } from "bun:test";
import { RuntimeControl } from "../src/server/runtime-control.ts";

describe("RuntimeControl", () => {
  test("closes all registered SSE streams and ignores close errors", () => {
    const runtime = new RuntimeControl();
    const closedReasons: string[] = [];

    runtime.registerSseStream({
      close(reason: string) {
        closedReasons.push(reason);
      },
    });

    runtime.registerSseStream({
      close() {
        throw new Error("already closed");
      },
    });

    runtime.closeSseStreams("shutdown");
    expect(closedReasons).toEqual(["shutdown"]);
    expect(runtime.getOpenSseStreamCount()).toBe(0);
  });

  test("cancels active run once and clears canceller", async () => {
    const runtime = new RuntimeControl();
    let cancelCalls = 0;

    runtime.setActiveRunCanceller(async () => {
      cancelCalls += 1;
    });

    await runtime.cancelActiveRun("shutdown");
    await runtime.cancelActiveRun("shutdown");

    expect(cancelCalls).toBe(1);
  });

  test("deduplicates concurrent cancellation requests", async () => {
    const runtime = new RuntimeControl();
    let cancelCalls = 0;
    let releaseCancellation!: () => void;
    const cancellationGate = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });

    runtime.setActiveRunCanceller(async () => {
      cancelCalls += 1;
      await cancellationGate;
    });

    const firstCancellation = runtime.cancelActiveRun("shutdown");
    const secondCancellation = runtime.cancelActiveRun("shutdown");
    await Bun.sleep(0);
    expect(cancelCalls).toBe(1);

    releaseCancellation();
    await Promise.all([firstCancellation, secondCancellation]);

    await runtime.cancelActiveRun("shutdown");

    expect(cancelCalls).toBe(1);
  });

  test("retains active run canceller when cancellation fails so callers can retry", async () => {
    const runtime = new RuntimeControl();
    let cancelCalls = 0;

    runtime.setActiveRunCanceller(async () => {
      cancelCalls += 1;
      if (cancelCalls === 1) {
        throw new Error("cancel failed");
      }
    });

    await expect(runtime.cancelActiveRun("shutdown")).rejects.toThrow("cancel failed");
    await runtime.cancelActiveRun("shutdown");
    await runtime.cancelActiveRun("shutdown");

    expect(cancelCalls).toBe(2);
  });

  test("stops registered engine subprocesses during cleanup", async () => {
    const runtime = new RuntimeControl();
    const stopReasons: string[] = [];

    runtime.registerEngineProcess({
      stop(reason: string) {
        stopReasons.push(reason);
      },
    });

    await runtime.cleanupEngineSubprocesses("shutdown");
    expect(stopReasons).toEqual(["shutdown"]);
  });

  test("continues engine cleanup when one stop throws synchronously", async () => {
    const runtime = new RuntimeControl();
    const stopReasons: string[] = [];

    runtime.registerEngineProcess({
      stop() {
        throw new Error("boom");
      },
    });

    runtime.registerEngineProcess({
      stop(reason: string) {
        stopReasons.push(reason);
      },
    });

    await runtime.cleanupEngineSubprocesses("shutdown");
    expect(stopReasons).toEqual(["shutdown"]);
  });
});
