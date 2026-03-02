import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runTargetsCommand,
  TargetsCommandUsageError,
} from "../src/cli/targets-command.ts";
import type { SshCommandSuccess } from "../src/server/ssh/ssh-exec.ts";
import { TargetProfileStore } from "../src/server/targets/target-profile-store.ts";

describe("targets command", () => {
  test("list/show/rm operate directly on local target profile storage", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-targets-cli-"));
    const store = new TargetProfileStore(join(tempDirectory, "targets"));
    const stdoutLines: string[] = [];

    try {
      await store.upsertProfile(createProfile("lab"));

      await runTargetsCommand(["list"], {
        targetProfiles: store,
        print: (message) => {
          stdoutLines.push(message);
        },
      });
      expect(stdoutLines.some((line) => line.includes("lab"))).toBe(true);

      stdoutLines.length = 0;

      await runTargetsCommand(["show", "lab"], {
        targetProfiles: store,
        print: (message) => {
          stdoutLines.push(message);
        },
      });
      expect(stdoutLines).toHaveLength(1);
      const showOutput = stdoutLines[0];
      if (!showOutput) {
        throw new Error("Expected show output to be present.");
      }

      const profile = JSON.parse(showOutput) as {
        id?: string;
      };
      expect(profile.id).toBe("lab");

      stdoutLines.length = 0;

      await runTargetsCommand(["rm", "lab"], {
        targetProfiles: store,
        print: (message) => {
          stdoutLines.push(message);
        },
      });
      expect(stdoutLines).toEqual(["Removed target profile 'lab'."]);
      await expect(store.getProfile("lab")).rejects.toThrow("was not found");
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("check runs echo ok through SSH helper", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-targets-cli-"));
    const store = new TargetProfileStore(join(tempDirectory, "targets"));
    const stdoutLines: string[] = [];
    const observedRemoteArgv: string[][] = [];

    try {
      await store.upsertProfile(createProfile("lab"));

      await runTargetsCommand(["check", "lab"], {
        targetProfiles: store,
        executeSsh: async (request) => {
          observedRemoteArgv.push([...request.remoteArgv]);
          return {
            argv: ["ssh", "..."],
            stdoutExcerpt: "ok",
            stderrExcerpt: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        },
        print: (message) => {
          stdoutLines.push(message);
        },
      });

      expect(observedRemoteArgv).toEqual([["echo", "ok"]]);
      expect(stdoutLines).toContain("Target 'lab' check succeeded.");
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("exec enforces enablement gate and allows --dry-run", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-targets-cli-"));
    const store = new TargetProfileStore(join(tempDirectory, "targets"));
    const stdoutLines: string[] = [];

    try {
      await store.upsertProfile(createProfile("lab"));

      await expect(
        runTargetsCommand(["exec", "lab", "--", "echo", "ok"], {
          targetProfiles: store,
          env: {},
          print: (message) => {
            stdoutLines.push(message);
          },
        }),
      ).rejects.toBeInstanceOf(TargetsCommandUsageError);

      await runTargetsCommand(["exec", "lab", "--dry-run", "--", "echo", "ok"], {
        targetProfiles: store,
        env: {},
        print: (message) => {
          stdoutLines.push(message);
        },
      });

      const dryRunOutput = JSON.parse(stdoutLines.at(-1) ?? "[]") as unknown[];
      expect(dryRunOutput[0]).toBe("ssh");
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("prints help for subcommand help flags", async () => {
    const stdoutLines: string[] = [];

    await runTargetsCommand(["list", "--help"], {
      print: (message) => {
        stdoutLines.push(message);
      },
    });

    await runTargetsCommand(["exec", "--help"], {
      print: (message) => {
        stdoutLines.push(message);
      },
    });

    expect(stdoutLines).toHaveLength(2);
    expect(stdoutLines[0]).toContain("Usage: chimera-bench targets <subcommand>");
    expect(stdoutLines[1]).toContain("Usage: chimera-bench targets <subcommand>");
  });

  test("ignores no-op separators for non-exec subcommands", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-targets-cli-"));
    const store = new TargetProfileStore(join(tempDirectory, "targets"));
    const stdoutLines: string[] = [];

    try {
      await store.upsertProfile(createProfile("lab"));

      await runTargetsCommand(["list", "--"], {
        targetProfiles: store,
        print: (message) => {
          stdoutLines.push(message);
        },
      });

      await runTargetsCommand(["show", "lab", "--"], {
        targetProfiles: store,
        print: (message) => {
          stdoutLines.push(message);
        },
      });

      expect(stdoutLines[0]).toContain("lab");
      expect(stdoutLines[1]).toContain('"id": "lab"');
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("exec streams remote output and prints warning when enabled", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-targets-cli-"));
    const store = new TargetProfileStore(join(tempDirectory, "targets"));
    const stderrLines: string[] = [];
    const streamedStdout: string[] = [];
    const streamedStderr: string[] = [];

    try {
      await store.upsertProfile(createProfile("lab"));

      await runTargetsCommand(["exec", "lab", "--", "echo", "ok"], {
        targetProfiles: store,
        env: {
          CHIMERA_ENABLE_TARGETS_EXEC: "1",
        },
        executeSsh: async (request) => {
          request.onStdoutChunk?.("ok\n");
          request.onStderrChunk?.("warn\n");
          return {
            argv: ["ssh", "..."],
            stdoutExcerpt: "ok",
            stderrExcerpt: "warn",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        },
        printError: (message) => {
          stderrLines.push(message);
        },
        writeStdout: (chunk) => {
          streamedStdout.push(chunk);
        },
        writeStderr: (chunk) => {
          streamedStderr.push(chunk);
        },
      });

      expect(
        stderrLines.some((line) => line.includes("runs arbitrary remote commands")),
      ).toBe(true);
      expect(streamedStdout).toEqual(["ok\n"]);
      expect(streamedStderr).toEqual(["warn\n"]);
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("list sanitizes control characters in displayName", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-targets-cli-"));
    const store = new TargetProfileStore(join(tempDirectory, "targets"));
    const stdoutLines: string[] = [];

    try {
      await store.upsertProfile(
        createProfile("lab", {
          displayName: "Lab\u001b[31mDanger\u001b[0m",
        }),
      );

      await runTargetsCommand(["list"], {
        targetProfiles: store,
        print: (message) => {
          stdoutLines.push(message);
        },
      });

      expect(stdoutLines).toHaveLength(1);
      expect(stdoutLines[0]?.includes("\u001b")).toBe(false);
      expect(stdoutLines[0]).toContain("Lab [31mDanger [0m");
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("exec checks enablement gate before profile lookup", async () => {
    await expect(
      runTargetsCommand(["exec", "missing", "--", "echo", "ok"], {
        env: {},
      }),
    ).rejects.toBeInstanceOf(TargetsCommandUsageError);
  });

  test("does not treat --help after -- as targets help", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-targets-cli-"));
    const store = new TargetProfileStore(join(tempDirectory, "targets"));
    const stdoutLines: string[] = [];

    try {
      await store.upsertProfile(createProfile("lab"));

      await runTargetsCommand([
        "exec",
        "lab",
        "--dry-run",
        "--",
        "echo",
        "--help",
      ], {
        targetProfiles: store,
        env: {},
        print: (message) => {
          stdoutLines.push(message);
        },
      });

      const parsedArgv = JSON.parse(stdoutLines[0] ?? "[]") as string[];
      expect(parsedArgv[0]).toBe("ssh");
      expect(parsedArgv.at(-1)).toContain("'--help'");
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("removes signal handlers on first cancellation signal", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-targets-cli-"));
    const store = new TargetProfileStore(join(tempDirectory, "targets"));
    const listeners = new Map<"SIGINT" | "SIGTERM", () => void>();
    const removedSignals: Array<"SIGINT" | "SIGTERM"> = [];
    let executeInvokedResolve: (() => void) | null = null;
    const executeInvoked = new Promise<void>((resolve) => {
      executeInvokedResolve = resolve;
    });

    try {
      await store.upsertProfile(createProfile("lab"));

      const commandPromise = runTargetsCommand(["exec", "lab", "--", "sleep", "60"], {
        targetProfiles: store,
        env: {
          CHIMERA_ENABLE_TARGETS_EXEC: "1",
        },
        addSignalListener: (signal, listener) => {
          listeners.set(signal, listener);
        },
        removeSignalListener: (signal) => {
          removedSignals.push(signal);
          listeners.delete(signal);
        },
        executeSsh: async (request): Promise<SshCommandSuccess> => {
          executeInvokedResolve?.();
          await new Promise<never>((_, reject) => {
            request.abortSignal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          });

          throw new Error("unreachable");
        },
      });

      await executeInvoked;

      const sigintHandler = listeners.get("SIGINT");
      if (!sigintHandler) {
        throw new Error("Expected SIGINT listener to be registered.");
      }

      sigintHandler();

      await expect(commandPromise).rejects.toThrow("aborted");
      expect(removedSignals).toContain("SIGINT");
      expect(removedSignals).toContain("SIGTERM");
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });
});

function createProfile(
  profileId: string,
  overrides: {
    displayName?: string;
  } = {},
): {
  schemaVersion: 1;
  id: string;
  displayName: string;
  host: string;
  port: number;
  username: string;
  auth: {
    method: "ssh-agent";
  };
  remoteModelRoots: string[];
  llamaServerPath: string;
} {
  return {
    schemaVersion: 1,
    id: profileId,
    displayName: overrides.displayName ?? "Lab LLM box",
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
