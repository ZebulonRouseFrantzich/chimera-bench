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
import type { TargetProfile } from "../src/server/targets/target-profile.ts";

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

  test("advertises SSH target capability", async () => {
    const plugin = createStarterLlamaCppPlugin();
    expect(plugin.capabilities.sshTarget).toBe(true);
  });

  test("uses cached remote strict flag discovery per profile/path with ttl", async () => {
    let discoveryCalls = 0;
    let nowMs = 1_000;
    const profile = createSshProfile("lab");

    const plugin = createStarterLlamaCppPlugin({
      getTargetProfile: async () => profile,
      discoverRemoteSupportedServerFlags: async () => {
        discoveryCalls += 1;
        return new Set(["--threads", "--model", "--host", "--port", "--api-key", "--no-webui"]);
      },
      remoteHelpCacheTtlMs: 100,
      now: () => nowMs,
    });

    const firstValidation = await plugin.validateRunConfig(
      createRunConfig({
        target: {
          type: "ssh",
          profileId: "lab",
        },
        modelIdentifier: "/models/model.gguf",
        serverArgs: ["--threads", "4"],
      }),
    );

    const secondValidation = await plugin.validateRunConfig(
      createRunConfig({
        target: {
          type: "ssh",
          profileId: "lab",
        },
        modelIdentifier: "/models/model.gguf",
        serverArgs: ["--threads", "8"],
      }),
    );

    expect(firstValidation.ok).toBe(true);
    expect(secondValidation.ok).toBe(true);
    expect(discoveryCalls).toBe(1);

    nowMs += 101;

    const thirdValidation = await plugin.validateRunConfig(
      createRunConfig({
        target: {
          type: "ssh",
          profileId: "lab",
        },
        modelIdentifier: "/models/model.gguf",
        serverArgs: ["--threads", "16"],
      }),
    );

    expect(thirdValidation.ok).toBe(true);
    expect(discoveryCalls).toBe(2);
  });

  test("invalidates remote strict flag cache when SSH connection identity changes", async () => {
    let discoveryCalls = 0;
    let profile = createSshProfile("lab");

    const plugin = createStarterLlamaCppPlugin({
      getTargetProfile: async () => profile,
      discoverRemoteSupportedServerFlags: async () => {
        discoveryCalls += 1;
        return new Set(["--threads", "--model", "--host", "--port", "--api-key", "--no-webui"]);
      },
      remoteHelpCacheTtlMs: 60_000,
      now: () => 1_000,
    });

    const firstValidation = await plugin.validateRunConfig(
      createRunConfig({
        target: {
          type: "ssh",
          profileId: "lab",
        },
        modelIdentifier: "/models/model.gguf",
        serverArgs: ["--threads", "4"],
      }),
    );
    expect(firstValidation.ok).toBe(true);

    profile = {
      ...profile,
      host: "10.0.0.11",
    };

    const secondValidation = await plugin.validateRunConfig(
      createRunConfig({
        target: {
          type: "ssh",
          profileId: "lab",
        },
        modelIdentifier: "/models/model.gguf",
        serverArgs: ["--threads", "8"],
      }),
    );
    expect(secondValidation.ok).toBe(true);
    expect(discoveryCalls).toBe(2);
  });

  test("rejects unknown server flags in strict SSH mode", async () => {
    const profile = createSshProfile("lab");
    const plugin = createStarterLlamaCppPlugin({
      getTargetProfile: async () => profile,
      discoverRemoteSupportedServerFlags: async () =>
        new Set(["--threads", "--model", "--host", "--port", "--api-key", "--no-webui"]),
    });

    const validationResult = await plugin.validateRunConfig(
      createRunConfig({
        target: {
          type: "ssh",
          profileId: "lab",
        },
        modelIdentifier: "/models/model.gguf",
        serverArgs: ["--not-a-real-flag"],
      }),
    );

    expect(validationResult.ok).toBe(false);
    if (!validationResult.ok) {
      expect(validationResult.issues?.[0]?.code).toBe("SERVER_ARG_UNKNOWN");
    }
  });

  test("fails strict SSH validation when remote --help markers are missing", async () => {
    const profile = createSshProfile("lab");

    const plugin = createStarterLlamaCppPlugin({
      getTargetProfile: async () => profile,
      executeSshCommand: async () => ({
        argv: ["ssh", "..."],
        stdoutExcerpt: "--threads\n--ctx-size",
        stderrExcerpt: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    });

    const validationResult = await plugin.validateRunConfig(
      createRunConfig({
        target: {
          type: "ssh",
          profileId: "lab",
        },
        modelIdentifier: "/models/model.gguf",
        serverArgs: ["--threads", "4"],
      }),
    );

    expect(validationResult.ok).toBe(false);
    if (!validationResult.ok) {
      expect(validationResult.code).toBe("VALIDATION_ENGINE_OPTIONS_INVALID");
      expect(validationResult.issues?.[0]?.code).toBe("SERVER_ARG_FLAG_DISCOVERY_FAILED");
    }
  });

  test("starts SSH-managed remote llama-server with loopback-only forwarding", async () => {
    const processHandle = new FakeChildProcess(64001);
    const signalCalls: NodeJS.Signals[] = [];
    const profile = createSshProfile("lab");
    let observedCommand = "";
    let observedArgs: string[] = [];

    const plugin = createStarterLlamaCppPlugin({
      getTargetProfile: async () => profile,
      createApiKey: () => TEST_API_KEY,
      allocateLoopbackPort: async () => 18080,
      allocateRemoteSshPort: () => 28080,
      startupProbeWindowMs: 5,
      sshStartupRetryAttempts: 1,
      spawnProcess: (command, args) => {
        observedCommand = command;
        observedArgs = [...args];
        return processHandle.asChildProcess();
      },
      signalProcessGroup: (_pid, signal) => {
        signalCalls.push(signal);
        if (signal === "SIGTERM") {
          processHandle.emitExit(0, null);
        }
      },
    });

    const launchConfig = await plugin.buildLaunchConfig(
      createRunConfig({
        target: {
          type: "ssh",
          profileId: "lab",
        },
        modelIdentifier: "/models/model.gguf",
        validationMode: "permissive",
      }),
    );
    const context = createContext("run_remote_start", launchConfig);

    await plugin.start(context);

    expect(observedCommand).toBe("ssh");
    expect(observedArgs).toContain("-L");
    expect(observedArgs).toContain("127.0.0.1:18080:127.0.0.1:28080");
    expect(observedArgs).toContain("ubuntu@10.0.0.10");
    expect(observedArgs.at(-1)).toContain("exec ");
    expect(observedArgs.at(-1)).toContain("--api-key");
    expect(observedArgs.at(-1)).toContain("--no-webui");

    await plugin.stop(context);
    expect(signalCalls).toEqual(["SIGTERM"]);
  });

  test("retries SSH startup with a new remote port on bind collisions", async () => {
    const profile = createSshProfile("lab");
    const remotePorts = [28080, 28081];
    const spawnArgs: string[][] = [];
    let activeProcess: FakeChildProcess | null = null;

    const plugin = createStarterLlamaCppPlugin({
      getTargetProfile: async () => profile,
      createApiKey: () => TEST_API_KEY,
      allocateLoopbackPort: async () => 18080,
      allocateRemoteSshPort: () => {
        const nextPort = remotePorts.shift();
        if (nextPort === undefined) {
          throw new Error("No remote SSH port available.");
        }

        return nextPort;
      },
      startupProbeWindowMs: 5,
      sshStartupRetryAttempts: 2,
      spawnProcess: (_command, args) => {
        spawnArgs.push([...args]);

        if (spawnArgs.length === 1) {
          const failedProcess = new FakeChildProcess(64003);
          queueMicrotask(() => {
            failedProcess.stderr.write("bind: Address already in use");
            failedProcess.emitExit(1, null);
          });
          return failedProcess.asChildProcess();
        }

        activeProcess = new FakeChildProcess(64004);
        return activeProcess.asChildProcess();
      },
      signalProcessGroup: (pid, signal) => {
        if (activeProcess && activeProcess.pid === pid && signal === "SIGTERM") {
          activeProcess.emitExit(0, null);
        }
      },
    });

    const launchConfig = await plugin.buildLaunchConfig(
      createRunConfig({
        target: {
          type: "ssh",
          profileId: "lab",
        },
        modelIdentifier: "/models/model.gguf",
        validationMode: "permissive",
      }),
    );

    const context = createContext("run_remote_retry", launchConfig);
    await plugin.start(context);

    expect(spawnArgs).toHaveLength(2);
    expect(spawnArgs[0]).toContain("127.0.0.1:18080:127.0.0.1:28080");
    expect(spawnArgs[1]).toContain("127.0.0.1:18080:127.0.0.1:28081");

    await plugin.stop(context);
  });

  test("reserves distinct SSH remote ports for concurrent runs", async () => {
    const profile = createSshProfile("lab");
    const remotePorts = [28080, 28080, 28081];
    const localPorts = [18080, 18081];
    const spawnedByPid = new Map<number, FakeChildProcess>();
    const spawnArgs: string[][] = [];

    let nextPid = 65000;
    const plugin = createStarterLlamaCppPlugin({
      getTargetProfile: async () => profile,
      createApiKey: () => TEST_API_KEY,
      allocateLoopbackPort: async () => {
        const nextPort = localPorts.shift();
        if (nextPort === undefined) {
          throw new Error("No local port available");
        }

        return nextPort;
      },
      allocateRemoteSshPort: () => {
        const nextPort = remotePorts.shift();
        if (nextPort === undefined) {
          throw new Error("No remote port available");
        }

        return nextPort;
      },
      startupProbeWindowMs: 5,
      sshStartupRetryAttempts: 2,
      spawnProcess: (_command, args) => {
        spawnArgs.push([...args]);
        const process = new FakeChildProcess(nextPid);
        nextPid += 1;
        spawnedByPid.set(process.pid, process);
        return process.asChildProcess();
      },
      signalProcessGroup: (pid, signal) => {
        const process = spawnedByPid.get(pid);
        if (process && signal === "SIGTERM") {
          process.emitExit(0, null);
        }
      },
    });

    const launchConfig = await plugin.buildLaunchConfig(
      createRunConfig({
        target: {
          type: "ssh",
          profileId: "lab",
        },
        modelIdentifier: "/models/model.gguf",
        validationMode: "permissive",
      }),
    );

    const contextOne = createContext("run_remote_concurrent_1", launchConfig);
    const contextTwo = createContext("run_remote_concurrent_2", launchConfig);

    await plugin.start(contextOne);
    await plugin.start(contextTwo);

    expect(spawnArgs).toHaveLength(2);
    expect(spawnArgs[0]).toContain("127.0.0.1:18080:127.0.0.1:28080");
    expect(spawnArgs[1]).toContain("127.0.0.1:18081:127.0.0.1:28081");

    await plugin.stop(contextOne);
    await plugin.stop(contextTwo);
  });

  test("classifies SSH transport startup failures as REMOTE_SSH_FAILED", async () => {
    const profile = createSshProfile("lab");

    const plugin = createStarterLlamaCppPlugin({
      getTargetProfile: async () => profile,
      createApiKey: () => TEST_API_KEY,
      allocateLoopbackPort: async () => 18080,
      allocateRemoteSshPort: () => 28080,
      startupProbeWindowMs: 5,
      sshStartupRetryAttempts: 1,
      spawnProcess: () => {
        const processHandle = new FakeChildProcess(64002);
        queueMicrotask(() => {
          processHandle.stderr.write("Permission denied (publickey).");
          processHandle.emitExit(255, null);
        });
        return processHandle.asChildProcess();
      },
    });

    const launchConfig = await plugin.buildLaunchConfig(
      createRunConfig({
        target: {
          type: "ssh",
          profileId: "lab",
        },
        modelIdentifier: "/models/model.gguf",
        validationMode: "permissive",
      }),
    );

    await expect(plugin.start(createContext("run_remote_auth_failure", launchConfig))).rejects.toMatchObject({
      code: "REMOTE_SSH_FAILED",
    });
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

    let startupError: (Error & {
      code?: string;
      details?: Record<string, unknown>;
    }) | null = null;

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
    target?: EngineRunConfig["target"];
  } = {},
): EngineRunConfig {
  return {
    engineId: "llama-cpp",
    target:
      options.target ??
      {
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

function createSshProfile(profileId: string): TargetProfile {
  return {
    schemaVersion: 1,
    id: profileId,
    displayName: "Lab LLM box",
    host: "10.0.0.10",
    port: 22,
    username: "ubuntu",
    auth: {
      method: "ssh-agent",
    },
    remoteModelRoots: ["/models"],
    llamaServerPath: "llama-server",
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
