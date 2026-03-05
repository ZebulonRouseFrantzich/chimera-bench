import { describe, expect, test } from "bun:test";
import {
  createContext,
  createRunConfig,
  createSshProfile,
  createStarterLlamaCppPlugin,
  FakeChildProcess,
  TEST_API_KEY,
  TEST_MODEL_IDENTIFIER,
} from "./helpers.ts";
import { waitForCondition } from "../helpers/wait-condition.ts";

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

  test("does not inject implicit GPU-selection defaults for SSH launch metadata", async () => {
    const profile = createSshProfile("lab");
    const plugin = createStarterLlamaCppPlugin({
      getTargetProfile: async () => profile,
    });

    const launchConfig = await plugin.buildLaunchConfig(
      createRunConfig({
        target: {
          type: "ssh",
          profileId: "lab",
        },
        modelIdentifier: "/models/model.gguf",
        validationMode: "permissive",
        serverArgs: ["--threads", "4"],
      }),
    );

    const metadata = launchConfig.metadata as {
      serverArgs?: string[];
    };
    expect(metadata.serverArgs).toEqual(["--threads", "4"]);
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

  test("validates and normalizes SSH model identifiers in plugin validation", async () => {
    const profile = createSshProfile("lab");
    const plugin = createStarterLlamaCppPlugin({
      getTargetProfile: async () => profile,
    });

    const invalidValidation = await plugin.validateRunConfig(
      createRunConfig({
        target: {
          type: "ssh",
          profileId: "lab",
        },
        modelIdentifier: "/outside/model.gguf",
        validationMode: "permissive",
      }),
    );

    expect(invalidValidation.ok).toBe(false);
    if (!invalidValidation.ok) {
      expect(invalidValidation.code).toBe("VALIDATION_MODEL_IDENTIFIER_INVALID");
      expect(
        invalidValidation.issues?.some((issue) => issue.code === "MODEL_IDENTIFIER_OUTSIDE_ALLOWED_ROOTS"),
      ).toBe(true);
    }

    const validValidation = await plugin.validateRunConfig(
      createRunConfig({
        target: {
          type: "ssh",
          profileId: "lab",
        },
        modelIdentifier: "/models//model.gguf",
        validationMode: "permissive",
      }),
    );

    expect(validValidation.ok).toBe(true);
    if (validValidation.ok) {
      expect(validValidation.normalized.modelIdentifier).toBe("/models/model.gguf");
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

  test("cleans up remote SSH runtime when session exits unexpectedly", async () => {
    const processHandle = new FakeChildProcess(64010);
    const profile = createSshProfile("lab");
    const cleanupCommands: string[][] = [];
    const releasedRemotePorts: number[] = [];

    const plugin = createStarterLlamaCppPlugin({
      getTargetProfile: async () => profile,
      createApiKey: () => TEST_API_KEY,
      allocateLoopbackPort: async () => 18080,
      allocateRemoteSshPort: () => 28080,
      startupProbeWindowMs: 5,
      sshStartupRetryAttempts: 1,
      spawnProcess: () => processHandle.asChildProcess(),
      signalProcessGroup: () => {
        return;
      },
      executeSshCommand: async (request) => {
        cleanupCommands.push([...request.remoteArgv]);
        return {
          argv: ["ssh", "..."],
          stdoutExcerpt: "",
          stderrExcerpt: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          exitCode: 1,
          signal: null,
        };
      },
      releaseRemoteSshPort: (_destinationKey, remotePort) => {
        releasedRemotePorts.push(remotePort);
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
    const context = createContext("run_remote_unexpected_exit_cleanup", launchConfig);

    await plugin.start(context);
    processHandle.emitExit(255, null);

    await waitForCondition(() => {
      return cleanupCommands.length > 0 && releasedRemotePorts.length > 0;
    });

    expect(cleanupCommands).toHaveLength(1);
    expect(cleanupCommands[0]).toEqual([
      "pkill",
      "-TERM",
      "-f",
      expect.any(String),
    ]);
    expect(releasedRemotePorts).toEqual([28080]);

    await plugin.stop(context);
    expect(cleanupCommands).toHaveLength(1);
  });

  test("issues TERM + liveness-check + KILL cleanup commands when SSH success omits exit codes", async () => {
    const processHandle = new FakeChildProcess(64011);
    const profile = createSshProfile("lab");
    const cleanupCommands: string[][] = [];

    const plugin = createStarterLlamaCppPlugin({
      getTargetProfile: async () => profile,
      createApiKey: () => TEST_API_KEY,
      allocateLoopbackPort: async () => 18080,
      allocateRemoteSshPort: () => 28080,
      startupProbeWindowMs: 5,
      sshStartupRetryAttempts: 1,
      spawnProcess: () => processHandle.asChildProcess(),
      signalProcessGroup: (_pid, signal) => {
        if (signal === "SIGTERM") {
          processHandle.emitExit(0, null);
        }
      },
      executeSshCommand: async (request) => {
        cleanupCommands.push([...request.remoteArgv]);

        const [command] = request.remoteArgv;
        if (command === "pgrep") {
          return {
            argv: ["ssh", "..."],
            stdoutExcerpt: "1234\n",
            stderrExcerpt: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }

        return {
          argv: ["ssh", "..."],
          stdoutExcerpt: "",
          stderrExcerpt: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      },
      wait: async () => {
        return;
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
    const context = createContext("run_remote_cleanup", launchConfig);

    await plugin.start(context);
    await plugin.stop(context);

    expect(cleanupCommands).toHaveLength(3);
    expect(cleanupCommands[0]).toEqual([
      "pkill",
      "-TERM",
      "-f",
      expect.stringContaining("--host 127\\.0\\.0\\.1 --port 28080 --no-webui"),
    ]);
    expect(cleanupCommands[1]).toEqual([
      "pgrep",
      "-f",
      expect.stringContaining("--host 127\\.0\\.0\\.1 --port 28080 --no-webui"),
    ]);
    expect(cleanupCommands[2]).toEqual([
      "pkill",
      "-KILL",
      "-f",
      expect.stringContaining("--host 127\\.0\\.0\\.1 --port 28080 --no-webui"),
    ]);
    const cleanupPattern = cleanupCommands[0]?.[3];
    expect(cleanupPattern?.includes("--no-webui")).toBe(true);
    expect(cleanupPattern?.includes(TEST_API_KEY)).toBe(false);
    expect(cleanupPattern?.includes("[[:space:]]")).toBe(true);
  });

  test("skips KILL cleanup when TERM finds no matching remote process", async () => {
    const processHandle = new FakeChildProcess(64012);
    const profile = createSshProfile("lab");
    const cleanupCommands: string[][] = [];

    const plugin = createStarterLlamaCppPlugin({
      getTargetProfile: async () => profile,
      createApiKey: () => TEST_API_KEY,
      allocateLoopbackPort: async () => 18080,
      allocateRemoteSshPort: () => 28080,
      startupProbeWindowMs: 5,
      sshStartupRetryAttempts: 1,
      spawnProcess: () => processHandle.asChildProcess(),
      signalProcessGroup: (_pid, signal) => {
        if (signal === "SIGTERM") {
          processHandle.emitExit(0, null);
        }
      },
      executeSshCommand: async (request) => {
        cleanupCommands.push([...request.remoteArgv]);
        return {
          argv: ["ssh", "..."],
          stdoutExcerpt: "",
          stderrExcerpt: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          exitCode: 1,
          signal: null,
        };
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
    const context = createContext("run_remote_cleanup_no_match", launchConfig);

    await plugin.start(context);
    await plugin.stop(context);

    expect(cleanupCommands).toHaveLength(1);
    expect(cleanupCommands[0]).toEqual([
      "pkill",
      "-TERM",
      "-f",
      expect.any(String),
    ]);
  });

  test("continues stop when remote cleanup SSH command throws", async () => {
    const processHandle = new FakeChildProcess(64013);
    const profile = createSshProfile("lab");
    let cleanupAttempts = 0;

    const plugin = createStarterLlamaCppPlugin({
      getTargetProfile: async () => profile,
      createApiKey: () => TEST_API_KEY,
      allocateLoopbackPort: async () => 18080,
      allocateRemoteSshPort: () => 28080,
      startupProbeWindowMs: 5,
      sshStartupRetryAttempts: 1,
      spawnProcess: () => processHandle.asChildProcess(),
      signalProcessGroup: (_pid, signal) => {
        if (signal === "SIGTERM") {
          processHandle.emitExit(0, null);
        }
      },
      executeSshCommand: async () => {
        cleanupAttempts += 1;
        throw new Error("synthetic ssh cleanup failure");
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
    const context = createContext("run_remote_cleanup_throws", launchConfig);

    await plugin.start(context);
    await expect(plugin.stop(context)).resolves.toBeUndefined();
    expect(cleanupAttempts).toBe(1);
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

  test("releases reserved SSH remote ports when argv construction fails", async () => {
    const profile = createSshProfile("lab");
    const reservedPorts: Array<{ destinationKey: string; remotePort: number }> = [];
    const releasedPorts: Array<{ destinationKey: string; remotePort: number }> = [];

    const plugin = createStarterLlamaCppPlugin({
      getTargetProfile: async () => profile,
      createApiKey: () => TEST_API_KEY,
      allocateLoopbackPort: async () => 0,
      allocateRemoteSshPort: () => 28080,
      sshStartupRetryAttempts: 1,
      reserveRemoteSshPort: (destinationKey, remotePort) => {
        reservedPorts.push({
          destinationKey,
          remotePort,
        });
        return true;
      },
      releaseRemoteSshPort: (destinationKey, remotePort) => {
        releasedPorts.push({
          destinationKey,
          remotePort,
        });
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

    const context = createContext("run_remote_port_release_on_throw", launchConfig);
    await expect(plugin.start(context)).rejects.toThrow(
      "localPort must be an integer between 1 and 65535.",
    );

    expect(reservedPorts).toHaveLength(1);
    expect(releasedPorts).toEqual(reservedPorts);
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

    await expect(
      plugin.start(createContext("run_remote_auth_failure", launchConfig)),
    ).rejects.toMatchObject({
      code: "REMOTE_SSH_FAILED",
    });
  });
});
