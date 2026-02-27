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
});
