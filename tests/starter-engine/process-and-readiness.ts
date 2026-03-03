import { describe, expect, test } from "bun:test";
import {
  createContext,
  createRunConfig,
  createStarterLlamaCppPlugin,
  FakeChildProcess,
  type SpawnOptionsWithoutStdio,
  TEST_API_KEY,
} from "./helpers.ts";

describe("starter llama.cpp plugin process lifecycle", () => {
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

  test("surfaces ENGINE_START_FAILED when llama-server executable is missing", async () => {
    const plugin = createStarterLlamaCppPlugin({
      allocateLoopbackPort: async () => 43129,
      createApiKey: () => TEST_API_KEY,
      startupRetryAttempts: 1,
      spawnProcess: () => {
        throw new Error('Executable not found in $PATH: "llama-server"');
      },
    });

    const launchConfig = await plugin.buildLaunchConfig(createRunConfig());
    const context = createContext("run_missing_binary", launchConfig);

    await expect(plugin.start(context)).rejects.toMatchObject({
      code: "ENGINE_START_FAILED",
    });
  });

  test("redacts api keys and bounds startup failure log excerpts", async () => {
    const processHandle = new FakeChildProcess(61000);

    const plugin = createStarterLlamaCppPlugin({
      allocateLoopbackPort: async () => 43133,
      createApiKey: () => TEST_API_KEY,
      startupProbeWindowMs: 5,
      startupRetryAttempts: 1,
      diagnosticExcerptChars: 80,
      spawnProcess: () => {
        queueMicrotask(() => {
          processHandle.stderr.write(`${"x".repeat(400)} stderr secret=${TEST_API_KEY}`);
          processHandle.stdout.write(`${"y".repeat(400)} stdout secret=${TEST_API_KEY}`);
          processHandle.emitExit(1, null);
        });

        return processHandle.asChildProcess();
      },
    });

    const launchConfig = await plugin.buildLaunchConfig(createRunConfig());
    const context = createContext("run_redaction", launchConfig);

    let startupError:
      | (Error & {
          code?: string;
          details?: Record<string, unknown>;
        })
      | null = null;

    try {
      await plugin.start(context);
    } catch (error) {
      startupError = error as Error & {
        code?: string;
        details?: Record<string, unknown>;
      };
    }

    expect(startupError).not.toBeNull();
    if (!startupError) {
      throw new Error("Expected startup to fail with ENGINE_START_FAILED.");
    }

    expect(startupError.code).toBe("ENGINE_START_FAILED");
    expect(startupError.message).toContain("[REDACTED]");
    expect(startupError.message).not.toContain(TEST_API_KEY);

    const launchCommand = String(startupError.details?.launchCommand ?? "");
    const stderrExcerpt = String(startupError.details?.stderrExcerpt ?? "");
    const stdoutExcerpt = String(startupError.details?.stdoutExcerpt ?? "");

    expect(launchCommand).toContain("[REDACTED]");
    expect(launchCommand).not.toContain(TEST_API_KEY);

    expect(stderrExcerpt).toContain("[REDACTED]");
    expect(stdoutExcerpt).toContain("[REDACTED]");
    expect(stderrExcerpt).not.toContain(TEST_API_KEY);
    expect(stdoutExcerpt).not.toContain(TEST_API_KEY);
    expect(stderrExcerpt.length).toBeLessThanOrEqual(80);
    expect(stdoutExcerpt.length).toBeLessThanOrEqual(80);
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

  test("waitUntilReady retries transient connection failures", async () => {
    const processHandle = new FakeChildProcess(62001);
    const signalCalls: NodeJS.Signals[] = [];
    let fetchCalls = 0;

    const plugin = createStarterLlamaCppPlugin({
      allocateLoopbackPort: async () => 43130,
      createApiKey: () => TEST_API_KEY,
      startupProbeWindowMs: 5,
      readinessPollIntervalMs: 1,
      readinessTimeoutMs: 50,
      readinessRequestTimeoutMs: 25,
      spawnProcess: () => processHandle.asChildProcess(),
      fetch: async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          const transientError = new Error("connect ECONNREFUSED 127.0.0.1");
          (transientError as NodeJS.ErrnoException).code = "ECONNREFUSED";
          throw transientError;
        }

        if (fetchCalls === 2) {
          return new Response("still loading", {
            status: 503,
          });
        }

        return new Response("ok", {
          status: 200,
        });
      },
      wait: async () => {
        return;
      },
      signalProcessGroup: (_pid, signal) => {
        signalCalls.push(signal);
        if (signal === "SIGTERM") {
          processHandle.emitExit(0, null);
        }
      },
    });

    const launchConfig = await plugin.buildLaunchConfig(createRunConfig());
    const context = createContext("run_ready_retry", launchConfig);

    await plugin.start(context);
    await plugin.waitUntilReady(context);
    expect(fetchCalls).toBe(3);

    await plugin.stop(context);
    expect(signalCalls).toEqual(["SIGTERM"]);
  });

  test("waitUntilReady retries when socket closes unexpectedly during startup", async () => {
    const processHandle = new FakeChildProcess(62011);
    const signalCalls: NodeJS.Signals[] = [];
    let fetchCalls = 0;

    const plugin = createStarterLlamaCppPlugin({
      allocateLoopbackPort: async () => 43140,
      createApiKey: () => TEST_API_KEY,
      startupProbeWindowMs: 5,
      readinessPollIntervalMs: 1,
      readinessTimeoutMs: 50,
      readinessRequestTimeoutMs: 25,
      spawnProcess: () => processHandle.asChildProcess(),
      fetch: async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          throw new Error(
            "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
          );
        }

        return new Response("ok", {
          status: 200,
        });
      },
      wait: async () => {
        return;
      },
      signalProcessGroup: (_pid, signal) => {
        signalCalls.push(signal);
        if (signal === "SIGTERM") {
          processHandle.emitExit(0, null);
        }
      },
    });

    const launchConfig = await plugin.buildLaunchConfig(createRunConfig());
    const context = createContext("run_ready_socket_closed_retry", launchConfig);

    await plugin.start(context);
    await plugin.waitUntilReady(context);
    expect(fetchCalls).toBe(2);

    await plugin.stop(context);
    expect(signalCalls).toEqual(["SIGTERM"]);
  });

  test("waitUntilReady surfaces ENGINE_START_FAILED on non-retryable health", async () => {
    const processHandle = new FakeChildProcess(62002);
    const signalCalls: NodeJS.Signals[] = [];

    const plugin = createStarterLlamaCppPlugin({
      allocateLoopbackPort: async () => 43131,
      createApiKey: () => TEST_API_KEY,
      startupProbeWindowMs: 5,
      readinessPollIntervalMs: 1,
      readinessTimeoutMs: 50,
      readinessRequestTimeoutMs: 25,
      spawnProcess: () => processHandle.asChildProcess(),
      fetch: async () => {
        return new Response("health endpoint not ready", {
          status: 418,
        });
      },
      signalProcessGroup: (_pid, signal) => {
        signalCalls.push(signal);
        if (signal === "SIGTERM") {
          processHandle.emitExit(0, null);
        }
      },
    });

    const launchConfig = await plugin.buildLaunchConfig(createRunConfig());
    const context = createContext("run_ready_failure", launchConfig);

    await plugin.start(context);
    await expect(plugin.waitUntilReady(context)).rejects.toMatchObject({
      code: "ENGINE_START_FAILED",
    });
    expect(signalCalls).toEqual(["SIGTERM"]);
  });

  test("waitUntilReady fails fast when process exits before readiness", async () => {
    const processHandle = new FakeChildProcess(62003);
    const signalCalls: NodeJS.Signals[] = [];
    let waitCalls = 0;

    const plugin = createStarterLlamaCppPlugin({
      allocateLoopbackPort: async () => 43132,
      createApiKey: () => TEST_API_KEY,
      startupProbeWindowMs: 5,
      readinessPollIntervalMs: 10,
      readinessTimeoutMs: 5_000,
      readinessRequestTimeoutMs: 250,
      spawnProcess: () => processHandle.asChildProcess(),
      fetch: async () => {
        const transientError = new Error("connect ECONNREFUSED 127.0.0.1");
        (transientError as NodeJS.ErrnoException).code = "ECONNREFUSED";
        throw transientError;
      },
      wait: async () => {
        waitCalls += 1;
      },
      signalProcessGroup: (_pid, signal) => {
        signalCalls.push(signal);
      },
    });

    const launchConfig = await plugin.buildLaunchConfig(createRunConfig());
    const context = createContext("run_ready_terminated", launchConfig);

    await plugin.start(context);
    processHandle.emitExit(1, null);

    await expect(plugin.waitUntilReady(context)).rejects.toMatchObject({
      code: "ENGINE_START_FAILED",
    });

    expect(waitCalls).toBe(0);
    expect(signalCalls.includes("SIGKILL")).toBe(false);
  });
});
