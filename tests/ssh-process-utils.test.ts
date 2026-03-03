import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { cancelSubprocess } from "../src/server/ssh/ssh-process-utils.ts";

describe("cancelSubprocess", () => {
  test("does not schedule escalation when SIGTERM is not sent", () => {
    const fake = createFakeProcess(() => false);
    let scheduledTimers = 0;

    cancelSubprocess(fake.process, {
      setTimer: ((handler: (...args: unknown[]) => void, timeout?: number) => {
        scheduledTimers += 1;
        return setTimeout(handler, timeout);
      }) as typeof setTimeout,
      clearTimer: clearTimeout,
      killGracePeriodMs: 10,
    });

    expect(fake.killSignals).toEqual(["SIGTERM"]);
    expect(scheduledTimers).toBe(0);
  });

  test("clears escalation timer when process closes after SIGTERM", async () => {
    const fake = createFakeProcess(() => true);
    let clearCalls = 0;

    cancelSubprocess(fake.process, {
      setTimer: setTimeout,
      clearTimer: ((timer: ReturnType<typeof setTimeout>) => {
        clearCalls += 1;
        clearTimeout(timer);
      }) as typeof clearTimeout,
      killGracePeriodMs: 25,
    });

    fake.emitClose(null, "SIGTERM");

    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });

    expect(clearCalls).toBeGreaterThan(0);
    expect(fake.killSignals).toEqual(["SIGTERM"]);
  });
});

function createFakeProcess(
  killBehavior: (signal: NodeJS.Signals) => boolean,
): {
  process: ChildProcessWithoutNullStreams;
  killSignals: NodeJS.Signals[];
  emitClose: (code: number | null, signal: NodeJS.Signals | null) => void;
} {
  const emitter = new EventEmitter();
  const killSignals: NodeJS.Signals[] = [];

  const process = emitter as unknown as ChildProcessWithoutNullStreams;
  const mutableProcess = process as unknown as {
    kill: (signal?: NodeJS.Signals) => boolean;
    exitCode: number | null;
  };

  mutableProcess.exitCode = null;
  mutableProcess.kill = (signal = "SIGTERM") => {
    killSignals.push(signal);
    return killBehavior(signal);
  };

  return {
    process,
    killSignals,
    emitClose: (code, signal) => {
      emitter.emit("close", code, signal);
    },
  };
}
