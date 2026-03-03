import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import {
  buildSshCommandArgv,
  classifySshFailureGuidance,
  executeSshCommand,
  SshCommandExecutionError,
} from "../src/server/ssh/ssh-exec.ts";

describe("buildSshCommandArgv", () => {
  test("builds argv with safe defaults for ssh-agent auth", () => {
    const argv = buildSshCommandArgv({
      profile: {
        host: "10.0.0.10",
        port: 22,
        username: "ubuntu",
        auth: {
          method: "ssh-agent",
        },
      },
      remoteArgv: ["echo", "ok"],
    });

    expect(argv).toEqual([
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=10",
      "-o",
      "ServerAliveCountMax=3",
      "-p",
      "22",
      "ubuntu@10.0.0.10",
      "'echo' 'ok'",
    ]);
  });

  test("includes identity file for key-path auth and preserves spaces", () => {
    const argv = buildSshCommandArgv({
      profile: {
        host: "example.com",
        port: 2222,
        username: "ops",
        auth: {
          method: "key-path",
          privateKeyPath: "/home/ops/.ssh/lab key",
        },
      },
      remoteArgv: ["printf", "%s", "hello world"],
    });

    expect(argv).toEqual([
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=10",
      "-o",
      "ServerAliveCountMax=3",
      "-i",
      "/home/ops/.ssh/lab key",
      "-p",
      "2222",
      "ops@example.com",
      "'printf' '%s' 'hello world'",
    ]);
  });

  test("rejects invalid username and host values", () => {
    expect(() =>
      buildSshCommandArgv({
        profile: {
          host: "-bad-host",
          port: 22,
          username: "ops",
          auth: {
            method: "ssh-agent",
          },
        },
        remoteArgv: ["echo", "ok"],
      }),
    ).toThrow("host must be a valid hostname or IP address");

    expect(() =>
      buildSshCommandArgv({
        profile: {
          host: "10.0.0.10",
          port: 22,
          username: "ops user",
          auth: {
            method: "ssh-agent",
          },
        },
        remoteArgv: ["echo", "ok"],
      }),
    ).toThrow("username must contain only ASCII letters");
  });
});

describe("classifySshFailureGuidance", () => {
  test("detects host key failures", () => {
    expect(
      classifySshFailureGuidance(
        "Host key verification failed.\r\nOffending key in ~/.ssh/known_hosts",
      ),
    ).toContain("known_hosts");
  });

  test("detects permission denied failures", () => {
    expect(classifySshFailureGuidance("Permission denied (publickey)."))
      .toContain("authentication failed");
  });

  test("detects missing ssh-agent identities", () => {
    expect(classifySshFailureGuidance("The agent has no identities."))
      .toContain("ssh-add");
  });
});

describe("executeSshCommand", () => {
  test("closes stdin, redacts secrets, and returns excerpts on success", async () => {
    const fake = createFakeSshProcess();
    const secret = "api-key-123";

    const promise = executeSshCommand(
      {
        profile: createProfile(),
        remoteArgv: ["echo", secret],
        redactions: [secret],
      },
      {
        spawnProcess: createSpawnProcessOverride(fake.process),
      },
    );

    fake.stdout.write(`ready ${secret}`);
    fake.stderr.write(`warn ${secret}`);
    fake.emitClose(0, null);

    const result = await promise;
    expect(fake.stdin.writableEnded).toBe(true);
    expect(result.argv.join(" ")).not.toContain(secret);
    expect(result.stdoutExcerpt).not.toContain(secret);
    expect(result.stderrExcerpt).not.toContain(secret);
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
  });

  test("includes actionable guidance on auth failure", async () => {
    const fake = createFakeSshProcess();

    const promise = executeSshCommand(
      {
        profile: createProfile(),
        remoteArgv: ["echo", "ok"],
      },
      {
        spawnProcess: createSpawnProcessOverride(fake.process),
      },
    );

    fake.stderr.write("Permission denied (publickey).");
    fake.emitClose(255, null);

    try {
      await promise;
      throw new Error("Expected command to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(SshCommandExecutionError);
      const executionError = error as SshCommandExecutionError;
      expect(executionError.message).toContain("authentication failed");
      expect(executionError.details.exitCode).toBe(255);
      expect(executionError.details.stderrExcerpt).toContain("Permission denied");
      expect(executionError.details.stdoutTruncated).toBe(false);
      expect(executionError.details.stderrTruncated).toBe(false);
    }
  });

  test("times out and escalates from SIGTERM to SIGKILL", async () => {
    const fake = createFakeSshProcess();
    const timers = createManualTimers();

    const promise = executeSshCommand(
      {
        profile: createProfile(),
        remoteArgv: ["sleep", "60"],
        overallTimeoutMs: 250,
      },
      {
        spawnProcess: createSpawnProcessOverride(fake.process),
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
      },
    );

    timers.runNext();
    expect(fake.killSignals).toEqual(["SIGTERM"]);

    timers.runNext();
    expect(fake.killSignals).toEqual(["SIGTERM", "SIGKILL"]);

    fake.emitClose(null, "SIGKILL");

    await expect(promise).rejects.toThrow("timed out");
  });

  test("abort signal cancels command and sends SIGTERM", async () => {
    const fake = createFakeSshProcess({
      autoCloseSignals: new Set(["SIGTERM"]),
    });
    const abortController = new AbortController();

    const promise = executeSshCommand(
      {
        profile: createProfile(),
        remoteArgv: ["sleep", "60"],
        abortSignal: abortController.signal,
      },
      {
        spawnProcess: createSpawnProcessOverride(fake.process),
      },
    );

    abortController.abort();

    await expect(promise).rejects.toThrow("was cancelled");
    expect(fake.killSignals[0]).toBe("SIGTERM");
  });

  test("reports truncation flags when buffered output exceeds cap", async () => {
    const fake = createFakeSshProcess();

    const promise = executeSshCommand(
      {
        profile: createProfile(),
        remoteArgv: ["echo", "ok"],
        maxBufferedChars: 8,
        diagnosticExcerptChars: 8,
      },
      {
        spawnProcess: createSpawnProcessOverride(fake.process),
      },
    );

    fake.stdout.write("0123456789AB");
    fake.stderr.write("abcdefghijk");
    fake.emitClose(0, null);

    const result = await promise;
    expect(result.stdoutExcerpt).toBe("456789AB");
    expect(result.stderrExcerpt).toBe("defghijk");
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
  });
});

function createProfile(): {
  host: string;
  port: number;
  username: string;
  auth: {
    method: "ssh-agent";
  };
} {
  return {
    host: "10.0.0.10",
    port: 22,
    username: "ubuntu",
    auth: {
      method: "ssh-agent",
    },
  };
}

function createSpawnProcessOverride(process: ChildProcessWithoutNullStreams): (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams {
  return (_command, _args, _options) => process;
}

function createManualTimers(): {
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
  runNext: () => void;
} {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();

  return {
    setTimer: ((callback: () => void) => {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimer: ((timerId: ReturnType<typeof setTimeout>) => {
      callbacks.delete(timerId as unknown as number);
    }) as typeof clearTimeout,
    runNext: (): void => {
      const entry = callbacks.entries().next().value;
      if (!entry) {
        throw new Error("Expected a pending timer callback.");
      }

      const [timerId, callback] = entry;
      callbacks.delete(timerId);
      callback();
    },
  };
}

function createFakeSshProcess(input: {
  autoCloseSignals?: ReadonlySet<NodeJS.Signals>;
} = {}): {
  process: ChildProcessWithoutNullStreams;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  killSignals: NodeJS.Signals[];
  emitClose: (code: number | null, signal: NodeJS.Signals | null) => void;
} {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const killSignals: NodeJS.Signals[] = [];

  const fake = emitter as unknown as ChildProcessWithoutNullStreams;
  const mutableFake = fake as unknown as {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    pid: number;
    kill(signal?: NodeJS.Signals): boolean;
    unref(): void;
  };

  mutableFake.stdout = stdout;
  mutableFake.stderr = stderr;
  mutableFake.stdin = stdin;
  mutableFake.pid = 1234;
  mutableFake.unref = () => {};
  mutableFake.kill = (signal = "SIGTERM"): boolean => {
    killSignals.push(signal);
    if (input.autoCloseSignals?.has(signal)) {
      queueMicrotask(() => {
        emitter.emit("close", null, signal);
      });
    }

    return true;
  };

  return {
    process: fake,
    stdout,
    stderr,
    stdin,
    killSignals,
    emitClose: (code, signal) => {
      emitter.emit("close", code, signal);
    },
  };
}
