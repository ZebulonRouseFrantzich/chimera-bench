import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import type {
  EngineLaunchConfig,
  EngineRunConfig,
  EngineRuntimeContext,
} from "../src/server/engines/engine-plugin.ts";
import { createStarterLlamaCppPlugin } from "../src/server/engines/starter-engine.ts";

const TEST_API_KEY = "k".repeat(43);

describe("starter llama.cpp plugin process lifecycle", () => {
  test("forces loopback launch args and per-run API key", async () => {
    const plugin = createStarterLlamaCppPlugin({
      allocateLoopbackPort: async () => 43123,
      createApiKey: () => TEST_API_KEY,
    });

    const launchConfig = await plugin.buildLaunchConfig(
      createRunConfig({
        serverArgs: ["--threads=4"],
      }),
    );

    expect(launchConfig.command).toBe("llama-server");
    expect(launchConfig.args).toContain("--model");
    expect(launchConfig.args).toContain("/tmp/model.gguf");
    expect(launchConfig.args).toContain("--host");
    expect(launchConfig.args).toContain("127.0.0.1");
    expect(launchConfig.args).toContain("--port");
    expect(launchConfig.args).toContain("43123");
    expect(launchConfig.args).toContain("--api-key");
    expect(launchConfig.args).toContain(TEST_API_KEY);
    expect(launchConfig.args).toContain("--no-webui");
    expect(launchConfig.args).toContain("--threads=4");
  });

  test("rejects weak api keys during start before spawning", async () => {
    let spawnCalls = 0;

    const plugin = createStarterLlamaCppPlugin({
      startupRetryAttempts: 1,
      spawnProcess: () => {
        spawnCalls += 1;
        return new FakeChildProcess(50001).asChildProcess();
      },
    });

    await expect(
      plugin.start(
        createContext("run_weak_key", {
          command: "llama-server",
          args: [
            "--model",
            "/tmp/model.gguf",
            "--host",
            "127.0.0.1",
            "--port",
            "43127",
            "--api-key",
            "short",
            "--no-webui",
          ],
        }),
      ),
    ).rejects.toThrow("too short");

    expect(spawnCalls).toBe(0);
  });

  test("rejects restricted environment overrides including macOS dyld keys", async () => {
    let spawnCalls = 0;

    const plugin = createStarterLlamaCppPlugin({
      startupRetryAttempts: 1,
      spawnProcess: () => {
        spawnCalls += 1;
        return new FakeChildProcess(50002).asChildProcess();
      },
    });

    await expect(
      plugin.start(
        createContext("run_restricted_env", {
          command: "llama-server",
          args: [
            "--model",
            "/tmp/model.gguf",
            "--host",
            "127.0.0.1",
            "--port",
            "43128",
            "--api-key",
            TEST_API_KEY,
            "--no-webui",
          ],
          environmentOverrides: {
            DYLD_INSERT_LIBRARIES: "/tmp/lib.dylib",
          },
        }),
      ),
    ).rejects.toThrow("restricted environment overrides");

    expect(spawnCalls).toBe(0);
  });

  test("retries startup with a new port when early bind failure occurs", async () => {
    const spawnArgs: string[][] = [];
    const signalCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const ports = [43124, 43125];
    const spawnedProcesses: FakeChildProcess[] = [];

    let activeProcess: FakeChildProcess | null = null;

    const plugin = createStarterLlamaCppPlugin({
      allocateLoopbackPort: async () => {
        const nextPort = ports.shift();
        if (nextPort === undefined) {
          throw new Error("No port available");
        }
        return nextPort;
      },
      createApiKey: () => TEST_API_KEY,
      startupProbeWindowMs: 5,
      startupRetryAttempts: 2,
      stopGracePeriodMs: 25,
      killWaitTimeoutMs: 25,
      spawnProcess: (_command, args) => {
        spawnArgs.push([...args]);

        if (spawnArgs.length === 1) {
          const failedProcess = new FakeChildProcess(51001);
          spawnedProcesses.push(failedProcess);
          queueMicrotask(() => {
            failedProcess.stderr.write("bind: Address already in use");
            failedProcess.emitExit(1, null);
          });
          return failedProcess.asChildProcess();
        }

        activeProcess = new FakeChildProcess(51002);
        spawnedProcesses.push(activeProcess);
        return activeProcess.asChildProcess();
      },
      signalProcessGroup: (pid, signal) => {
        signalCalls.push({ pid, signal });
        if (activeProcess && activeProcess.pid === pid && signal === "SIGTERM") {
          activeProcess.emitExit(0, null);
        }
      },
    });

    const launchConfig = await plugin.buildLaunchConfig(createRunConfig());
    const context = createContext("run_retry", launchConfig);

    await plugin.start(context);
    expect(spawnArgs).toHaveLength(2);
    expect(spawnArgs[0]).toContain("43124");
    expect(spawnArgs[1]).toContain("43125");
    expect(spawnedProcesses[1]?.unrefCalled).toBe(true);

    await plugin.stop(context);
    expect(signalCalls).toEqual([{ pid: 51002, signal: "SIGTERM" }]);
  });

  test("escalates to SIGKILL when graceful shutdown timeout elapses", async () => {
    const signalCalls: NodeJS.Signals[] = [];
    const processHandle = new FakeChildProcess(61001);

    const plugin = createStarterLlamaCppPlugin({
      allocateLoopbackPort: async () => 43126,
      createApiKey: () => TEST_API_KEY,
      startupProbeWindowMs: 5,
      stopGracePeriodMs: 5,
      killWaitTimeoutMs: 25,
      spawnProcess: (
        _command: string,
        _args: string[],
        _options: SpawnOptionsWithoutStdio,
      ) => {
        return processHandle.asChildProcess();
      },
      signalProcessGroup: (_pid, signal) => {
        signalCalls.push(signal);
        if (signal === "SIGKILL") {
          processHandle.emitExit(0, null);
        }
      },
    });

    const launchConfig = await plugin.buildLaunchConfig(createRunConfig());
    const context = createContext("run_kill", launchConfig);

    await plugin.start(context);
    await plugin.stop(context);

    expect(signalCalls).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  unrefCalled = false;

  constructor(public readonly pid: number) {
    super();
  }

  kill(_signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    return true;
  }

  unref(): this {
    this.unrefCalled = true;
    return this;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.stdout.end();
    this.stderr.end();
  }

  asChildProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

function createRunConfig(
  options: {
    serverArgs?: string[];
  } = {},
): EngineRunConfig {
  return {
    engineId: "llama-cpp",
    target: {
      type: "local",
    },
    model: {
      identifier: "/tmp/model.gguf",
    },
    workloadId: "starter.v1",
    validationMode: "strict",
    engine: {
      serverArgs: options.serverArgs ?? [],
      requestParams: {},
    },
  };
}

function createContext(runId: string, launchConfig: EngineLaunchConfig): EngineRuntimeContext {
  return {
    runId,
    abortSignal: new AbortController().signal,
    launchConfig,
  };
}
