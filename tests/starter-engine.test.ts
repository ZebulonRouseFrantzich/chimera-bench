import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import type {
  EngineLaunchConfig,
  EngineRunConfig,
  EngineRuntimeContext,
} from "../src/server/engines/engine-plugin.ts";
import { createStarterLlamaCppPlugin } from "../src/server/engines/starter-engine.ts";

const TEST_API_KEY = "k".repeat(43);
const TEST_MODEL_IDENTIFIER = "/tmp/model.gguf";

ensureTestModelFixture();

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
    expect(launchConfig.args).toContain(TEST_MODEL_IDENTIFIER);
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

  test("validates strict server flags via llama-server --help discovery", async () => {
    const plugin = createStarterLlamaCppPlugin({
      discoverSupportedServerFlags: async () =>
        new Set([
          "--threads",
          "--ctx-size",
        ]),
    });

    const strictKnownResult = await plugin.validateRunConfig(
      createRunConfig({
        serverArgs: ["--threads", "4"],
      }),
    );
    expect(strictKnownResult.ok).toBe(true);
    if (strictKnownResult.ok) {
      expect(strictKnownResult.normalized.modelIdentifier).toBe(TEST_MODEL_IDENTIFIER);
    }

    const strictUnknownResult = await plugin.validateRunConfig(
      createRunConfig({
        serverArgs: ["--not-a-real-flag"],
      }),
    );
    expect(strictUnknownResult.ok).toBe(false);
    if (!strictUnknownResult.ok) {
      expect(strictUnknownResult.issues?.[0]?.code).toBe("SERVER_ARG_UNKNOWN");
    }

    const permissiveUnknownResult = await plugin.validateRunConfig(
      createRunConfig({
        validationMode: "permissive",
        serverArgs: ["--not-a-real-flag"],
      }),
    );
    expect(permissiveUnknownResult.ok).toBe(true);
  });

  test("fails strict validation when --help parsing fails", async () => {
    const plugin = createStarterLlamaCppPlugin({
      discoverSupportedServerFlags: async () => {
        throw new Error("llama-server not found");
      },
    });

    const validationResult = await plugin.validateRunConfig(
      createRunConfig({
        serverArgs: ["--threads", "4"],
      }),
    );

    expect(validationResult.ok).toBe(false);
    if (!validationResult.ok) {
      expect(validationResult.code).toBe("VALIDATION_ENGINE_OPTIONS_INVALID");
      expect(validationResult.issues?.[0]?.code).toBe("SERVER_ARG_FLAG_DISCOVERY_FAILED");
    }
  });

  test("supports strict/permissive requestParams behavior", async () => {
    const plugin = createStarterLlamaCppPlugin({
      discoverSupportedServerFlags: async () => new Set(["--threads"]),
    });

    const strictTopPResult = await plugin.validateRunConfig(
      createRunConfig({
        requestParams: {
          top_p: 0,
        },
      }),
    );
    expect(strictTopPResult.ok).toBe(true);

    const strictResult = await plugin.validateRunConfig(
      createRunConfig({
        requestParams: {
          made_up: 123,
        },
      }),
    );
    expect(strictResult.ok).toBe(false);
    if (!strictResult.ok) {
      expect(strictResult.issues?.[0]?.code).toBe("REQUEST_PARAM_UNKNOWN");
    }

    const permissiveResult = await plugin.validateRunConfig(
      createRunConfig({
        validationMode: "permissive",
        requestParams: {
          made_up: 123,
        },
      }),
    );
    expect(permissiveResult.ok).toBe(true);
  });

  test("reports model root configuration errors with dedicated code", async () => {
    const plugin = createStarterLlamaCppPlugin({
      discoverSupportedServerFlags: async () => new Set(["--threads"]),
      modelRoots: ["/tmp/chimera-missing-root"],
    });

    const validationResult = await plugin.validateRunConfig(createRunConfig());

    expect(validationResult.ok).toBe(false);
    if (!validationResult.ok) {
      expect(validationResult.code).toBe("VALIDATION_MODEL_ROOTS_INVALID");
      expect(validationResult.issues?.[0]?.code).toBe("MODEL_ROOT_NOT_FOUND");
      expect(validationResult.issues?.[0]?.message).not.toContain("/tmp/chimera-missing-root");
    }
  });

  test("rejects model paths outside CHIMERA_MODEL_ROOTS after symlink resolution", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-model-root-"));
    const rootDirectory = join(tempDirectory, "root");
    const outsideModelPath = join(tempDirectory, "outside.gguf");
    const escapedModelPath = join(rootDirectory, "escaped.gguf");

    mkdirSync(rootDirectory);
    writeFileSync(outsideModelPath, "outside");
    symlinkSync(outsideModelPath, escapedModelPath);

    const plugin = createStarterLlamaCppPlugin({
      discoverSupportedServerFlags: async () => new Set(["--threads"]),
      modelRoots: [rootDirectory],
    });

    const validationResult = await plugin.validateRunConfig(
      createRunConfig({
        modelIdentifier: escapedModelPath,
      }),
    );

    expect(validationResult.ok).toBe(false);
    if (!validationResult.ok) {
      expect(validationResult.code).toBe("VALIDATION_MODEL_IDENTIFIER_INVALID");
      expect(validationResult.issues?.[0]?.code).toBe(
        "MODEL_IDENTIFIER_OUTSIDE_ALLOWED_ROOTS",
      );
    }

    rmSync(tempDirectory, {
      recursive: true,
      force: true,
    });
  });

  test("rejects sibling paths that only share root prefix", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-model-root-prefix-"));
    const rootDirectory = join(tempDirectory, "models");
    const siblingDirectory = join(tempDirectory, "modelsevil");
    const siblingModelPath = join(siblingDirectory, "outside.gguf");

    mkdirSync(rootDirectory);
    mkdirSync(siblingDirectory);
    writeFileSync(siblingModelPath, "outside");

    const plugin = createStarterLlamaCppPlugin({
      discoverSupportedServerFlags: async () => new Set(["--threads"]),
      modelRoots: [rootDirectory],
    });

    const validationResult = await plugin.validateRunConfig(
      createRunConfig({
        modelIdentifier: siblingModelPath,
      }),
    );

    expect(validationResult.ok).toBe(false);
    if (!validationResult.ok) {
      expect(validationResult.issues?.[0]?.code).toBe(
        "MODEL_IDENTIFIER_OUTSIDE_ALLOWED_ROOTS",
      );
    }

    rmSync(tempDirectory, {
      recursive: true,
      force: true,
    });
  });

  test("parses negative numeric server arg values correctly", async () => {
    const plugin = createStarterLlamaCppPlugin({
      discoverSupportedServerFlags: async () => new Set(["--temp"]),
    });

    const validationResult = await plugin.validateRunConfig(
      createRunConfig({
        serverArgs: ["--temp", "-0.5"],
      }),
    );

    expect(validationResult.ok).toBe(true);
  });

  test("caches strict flag discovery across validations", async () => {
    let discoveryCalls = 0;
    const plugin = createStarterLlamaCppPlugin({
      discoverSupportedServerFlags: async () => {
        discoveryCalls += 1;
        return new Set(["--threads"]);
      },
    });

    const firstValidation = await plugin.validateRunConfig(
      createRunConfig({
        serverArgs: ["--threads", "4"],
      }),
    );
    const secondValidation = await plugin.validateRunConfig(
      createRunConfig({
        serverArgs: ["--threads", "8"],
      }),
    );

    expect(firstValidation.ok).toBe(true);
    expect(secondValidation.ok).toBe(true);
    expect(discoveryCalls).toBe(1);
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
    requestParams?: Record<string, unknown>;
    validationMode?: "strict" | "permissive";
    modelIdentifier?: string;
  } = {},
): EngineRunConfig {
  return {
    engineId: "llama-cpp",
    target: {
      type: "local",
    },
    model: {
      identifier: options.modelIdentifier ?? TEST_MODEL_IDENTIFIER,
    },
    workloadId: "starter.v1",
    validationMode: options.validationMode ?? "strict",
    engine: {
      serverArgs: options.serverArgs ?? [],
      requestParams: options.requestParams ?? {},
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

function ensureTestModelFixture(): void {
  if (existsSync(TEST_MODEL_IDENTIFIER)) {
    return;
  }

  writeFileSync(TEST_MODEL_IDENTIFIER, "fixture");
}
