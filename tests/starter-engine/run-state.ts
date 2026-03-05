import { describe, expect, test } from "bun:test";
import { createDependencies } from "../../src/server/engines/starter-engine/dependencies.ts";
import { stopRunState } from "../../src/server/engines/starter-engine/run-state.ts";
import type {
  LlamaServerRunState,
  ProcessTermination,
} from "../../src/server/engines/starter-engine/types.ts";
import { RollingTextBuffer } from "../../src/server/engines/starter-engine/types.ts";
import { createSshProfile, FakeChildProcess, TEST_API_KEY } from "./helpers.ts";

function createResolvedTerminationPromise(): Promise<ProcessTermination> {
  return Promise.resolve({
    kind: "exit",
    code: 0,
    signal: null,
  });
}

function createBaseSshRunState(overrides: Partial<LlamaServerRunState> = {}): LlamaServerRunState {
  const process = new FakeChildProcess(75001);

  return {
    mode: "ssh",
    process: process.asChildProcess(),
    terminationPromise: createResolvedTerminationPromise(),
    stdoutBuffer: new RollingTextBuffer(2_048),
    stderrBuffer: new RollingTextBuffer(2_048),
    healthUrl: "http://127.0.0.1:18080/health",
    healthRequestHeaders: {},
    apiKey: TEST_API_KEY,
    modelIdentifier: "/models/model.gguf",
    contextWindowTokens: null,
    remotePortReservation: {
      destinationKey: "ubuntu@10.0.0.10:22",
      remotePort: 28080,
    },
    sshManagedRuntime: {
      profile: createSshProfile("lab"),
    },
    removeAbortListener: () => {
      return;
    },
    ...overrides,
  };
}

describe("starter-engine run-state cleanup", () => {
  test("skips remote cleanup gracefully when ssh runtime metadata is missing", async () => {
    const releasedPorts: Array<{ destinationKey: string; remotePort: number }> = [];
    let sshCleanupCalls = 0;

    const dependencies = createDependencies({
      signalProcessGroup: () => {
        return;
      },
      releaseRemoteSshPort: (destinationKey, remotePort) => {
        releasedPorts.push({
          destinationKey,
          remotePort,
        });
      },
      executeSshCommand: async () => {
        sshCleanupCalls += 1;
        return {
          argv: ["ssh", "..."],
          stdoutExcerpt: "",
          stderrExcerpt: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          exitCode: 0,
          signal: null,
        };
      },
    });

    const runState = createBaseSshRunState();
    delete runState.sshManagedRuntime;

    await expect(
      stopRunState(runState, {
        runId: "run_missing_runtime_metadata",
        reason: "stop",
        emitDiagnostic: undefined,
        dependencies,
      }),
    ).resolves.toBeUndefined();

    expect(sshCleanupCalls).toBe(0);
    expect(releasedPorts).toEqual([
      {
        destinationKey: "ubuntu@10.0.0.10:22",
        remotePort: 28080,
      },
    ]);
  });

  test("treats null SSH cleanup exit code as indeterminate and skips KILL", async () => {
    const cleanupCommands: string[][] = [];

    const dependencies = createDependencies({
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
          exitCode: null,
          signal: "SIGTERM",
        };
      },
    });

    const runState = createBaseSshRunState();

    await stopRunState(runState, {
      runId: "run_cleanup_null_exit",
      reason: "stop",
      emitDiagnostic: undefined,
      dependencies,
    });

    expect(cleanupCommands).toHaveLength(1);
    expect(cleanupCommands[0]).toEqual([
      "pkill",
      "-TERM",
      "-f",
      expect.any(String),
    ]);
  });

  test("treats missing SSH cleanup exit code as successful TERM dispatch", async () => {
    const cleanupCommands: string[][] = [];

    const dependencies = createDependencies({
      signalProcessGroup: () => {
        return;
      },
      wait: async () => {
        return;
      },
      executeSshCommand: async (request) => {
        cleanupCommands.push([...request.remoteArgv]);

        if (request.remoteArgv[0] === "pgrep") {
          return {
            argv: ["ssh", "..."],
            stdoutExcerpt: "",
            stderrExcerpt: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            exitCode: 1,
            signal: null,
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
    });

    const runState = createBaseSshRunState();

    await stopRunState(runState, {
      runId: "run_cleanup_missing_exit_code",
      reason: "stop",
      emitDiagnostic: undefined,
      dependencies,
    });

    expect(cleanupCommands).toHaveLength(2);
    expect(cleanupCommands[0]).toEqual([
      "pkill",
      "-TERM",
      "-f",
      expect.any(String),
    ]);
    expect(cleanupCommands[1]).toEqual([
      "pgrep",
      "-f",
      expect.any(String),
    ]);
  });

  test("deduplicates concurrent stop calls with one cleanup sequence", async () => {
    let localSignalCalls = 0;
    const cleanupCommands: string[][] = [];

    const dependencies = createDependencies({
      signalProcessGroup: () => {
        localSignalCalls += 1;
      },
      executeSshCommand: async (request) => {
        cleanupCommands.push([...request.remoteArgv]);
        await new Promise((resolvePromise) => {
          setTimeout(resolvePromise, 25);
        });

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

    const runState = createBaseSshRunState();

    await Promise.all([
      stopRunState(runState, {
        runId: "run_stop_once",
        reason: "stop",
        emitDiagnostic: undefined,
        dependencies,
      }),
      stopRunState(runState, {
        runId: "run_stop_once",
        reason: "stop",
        emitDiagnostic: undefined,
        dependencies,
      }),
    ]);

    expect(localSignalCalls).toBe(1);
    expect(cleanupCommands).toHaveLength(1);
    expect(cleanupCommands[0]?.[0]).toBe("pkill");
  });
});
