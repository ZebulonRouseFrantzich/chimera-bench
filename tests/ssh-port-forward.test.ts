import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import {
  buildSshPortForwardArgv,
  SshPortForwardExecutionError,
  startSshPortForward,
} from "../src/server/ssh/ssh-port-forward.ts";

describe("buildSshPortForwardArgv", () => {
  test("builds argv with loopback-only forwarding and fail-fast option", () => {
    const argv = buildSshPortForwardArgv({
      profile: {
        host: "10.0.0.10",
        port: 22,
        username: "ubuntu",
        auth: {
          method: "ssh-agent",
        },
      },
      localPort: 18080,
      remotePort: 28080,
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
      "-o",
      "ExitOnForwardFailure=yes",
      "-N",
      "-L",
      "127.0.0.1:18080:127.0.0.1:28080",
      "ubuntu@10.0.0.10",
    ]);
  });

  test("includes identity file for key-path auth", () => {
    const argv = buildSshPortForwardArgv({
      profile: {
        host: "example.com",
        port: 2222,
        username: "ops",
        auth: {
          method: "key-path",
          privateKeyPath: "/home/ops/.ssh/lab key",
        },
      },
      localPort: 19090,
      remotePort: 8080,
    });

    expect(argv).toContain("-i");
    expect(argv).toContain("/home/ops/.ssh/lab key");
    expect(argv).toContain("127.0.0.1:19090:127.0.0.1:8080");
  });

  test("rejects out-of-range ports", () => {
    expect(() =>
      buildSshPortForwardArgv({
        profile: {
          host: "10.0.0.10",
          port: 22,
          username: "ubuntu",
          auth: {
            method: "ssh-agent",
          },
        },
        localPort: 0,
        remotePort: 8080,
      }),
    ).toThrow("localPort must be an integer between 1 and 65535");

    expect(() =>
      buildSshPortForwardArgv({
        profile: {
          host: "10.0.0.10",
          port: 22,
          username: "ubuntu",
          auth: {
            method: "ssh-agent",
          },
        },
        localPort: 18080,
        remotePort: 70000,
      }),
    ).toThrow("remotePort must be an integer between 1 and 65535");
  });
});

describe("startSshPortForward", () => {
  test("retries auto-selected local ports when local forwarding bind fails", async () => {
    const first = createFakeSshProcess();
    const second = createFakeSshProcess();
    const reservedPorts = [18080, 18081];
    let spawnCount = 0;

    const handle = await startSshPortForward(
      {
        profile: createProfile(),
        remotePort: 8080,
      },
      {
        reserveLocalPort: async () => {
          const next = reservedPorts.shift();
          if (!next) {
            throw new Error("No reserved ports remaining.");
          }

          return next;
        },
        spawnProcess: createSpawnProcessOverride((_command, _args, _options) => {
          spawnCount += 1;
          if (spawnCount === 1) {
            queueMicrotask(() => {
              first.stderr.write("bind [127.0.0.1]:18080: Address already in use");
              first.emitClose(255, null);
            });
            return first.process;
          }

          return second.process;
        }),
        probeForwardReady: async (localPort) => localPort === 18081,
      },
    );

    expect(handle.localPort).toBe(18081);
    expect(spawnCount).toBe(2);

    const waitPromise = handle.waitForExit();
    second.emitClose(0, null);
    await expect(waitPromise).resolves.toBeUndefined();
  });

  test("does not retry on authentication failures", async () => {
    const fake = createFakeSshProcess();
    let reserveCalls = 0;
    let spawnCalls = 0;

    await expect(
      startSshPortForward(
        {
          profile: createProfile(),
          remotePort: 8080,
        },
        {
          reserveLocalPort: async () => {
            reserveCalls += 1;
            return 18080;
          },
          spawnProcess: createSpawnProcessOverride((_command, _args, _options) => {
            spawnCalls += 1;
            queueMicrotask(() => {
              fake.stderr.write("Permission denied (publickey).");
              fake.emitClose(255, null);
            });
            return fake.process;
          }),
          probeForwardReady: async () => false,
        },
      ),
    ).rejects.toThrow("authentication failed");

    expect(reserveCalls).toBe(1);
    expect(spawnCalls).toBe(1);
  });

  test("cancellation during startup aborts and terminates ssh", async () => {
    const fake = createFakeSshProcess({
      autoCloseSignals: new Set(["SIGTERM"]),
    });
    const abortController = new AbortController();

    const promise = startSshPortForward(
      {
        profile: createProfile(),
        remotePort: 8080,
        startupTimeoutMs: 5_000,
        abortSignal: abortController.signal,
      },
      {
        reserveLocalPort: async () => 18080,
        spawnProcess: createSpawnProcessOverride(fake.process),
        probeForwardReady: async () => false,
      },
    );

    abortController.abort();

    await expect(promise).rejects.toThrow("cancelled before startup completed");
    expect(fake.killSignals[0]).toBe("SIGTERM");
  });

  test("startup timeout cancels ssh process", async () => {
    const fake = createFakeSshProcess({
      autoCloseSignals: new Set(["SIGTERM"]),
    });
    let now = 0;

    await expect(
      startSshPortForward(
        {
          profile: createProfile(),
          remotePort: 8080,
          startupTimeoutMs: 40,
        },
        {
          now: () => {
            const current = now;
            now += 50;
            return current;
          },
          reserveLocalPort: async () => 18080,
          spawnProcess: createSpawnProcessOverride(fake.process),
          probeForwardReady: async () => false,
        },
      ),
    ).rejects.toThrow("did not become ready within 40ms");

    expect(fake.killSignals[0]).toBe("SIGTERM");
  });

  test("clears poll timer when process terminates during startup wait", async () => {
    const fake = createFakeSshProcess();
    let probeCalls = 0;
    let clearTimerCalls = 0;

    await expect(
      startSshPortForward(
        {
          profile: createProfile(),
          remotePort: 8080,
          startupTimeoutMs: 5_000,
        },
        {
          reserveLocalPort: async () => 18080,
          spawnProcess: createSpawnProcessOverride(fake.process),
          probeForwardReady: async () => {
            probeCalls += 1;
            if (probeCalls === 1) {
              queueMicrotask(() => {
                fake.emitClose(255, null);
              });
            }

            return false;
          },
          setTimer: setTimeout,
          clearTimer: ((timer: ReturnType<typeof setTimeout>) => {
            clearTimerCalls += 1;
            clearTimeout(timer);
          }) as typeof clearTimeout,
        },
      ),
    ).rejects.toThrow("during startup");

    expect(clearTimerCalls).toBeGreaterThan(0);
  });

  test("fails fast when remote loopback port refuses forwarded connections", async () => {
    const fake = createFakeSshProcess({
      autoCloseSignals: new Set(["SIGTERM"]),
    });

    await expect(
      startSshPortForward(
        {
          profile: createProfile(),
          remotePort: 65511,
          startupTimeoutMs: 10_000,
        },
        {
          reserveLocalPort: async () => 18080,
          spawnProcess: createSpawnProcessOverride((_command, _args, _options) => {
            queueMicrotask(() => {
              fake.stderr.write(
                "channel 3: open failed: connect failed: Connection refused\n",
              );
            });
            return fake.process;
          }),
          probeForwardReady: async () => false,
        },
      ),
    ).rejects.toThrow("could not connect to remote 127.0.0.1:65511");

    expect(fake.killSignals[0]).toBe("SIGTERM");
  });

  test("fails startup if ssh exits right after readiness probe", async () => {
    const fake = createFakeSshProcess();

    await expect(
      startSshPortForward(
        {
          profile: createProfile(),
          remotePort: 8080,
        },
        {
          reserveLocalPort: async () => 18080,
          spawnProcess: createSpawnProcessOverride(fake.process),
          probeForwardReady: async () => {
            queueMicrotask(() => {
              fake.emitClose(255, null);
            });
            return true;
          },
        },
      ),
    ).rejects.toThrow("during startup");
  });

  test("redacts sensitive stderr excerpts in waitForExit errors", async () => {
    const fake = createFakeSshProcess();
    const secret = "api-key-123";

    const handle = await startSshPortForward(
      {
        profile: createProfile(),
        remotePort: 8080,
        redactions: [secret],
      },
      {
        reserveLocalPort: async () => 18080,
        spawnProcess: createSpawnProcessOverride(fake.process),
        probeForwardReady: async () => true,
      },
    );

    const waitPromise = handle.waitForExit();
    fake.stderr.write(`token ${secret}`);
    fake.emitClose(255, null);

    try {
      await waitPromise;
      throw new Error("Expected waitForExit to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(SshPortForwardExecutionError);
      const executionError = error as SshPortForwardExecutionError;
      expect(executionError.details.stderrExcerpt).not.toContain(secret);
      expect(executionError.details.stderrExcerpt).toContain("[REDACTED]");
    }
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

function createSpawnProcessOverride(
  processOrFactory:
    | ChildProcessWithoutNullStreams
    | ((
        command: string,
        args: string[],
        options: SpawnOptionsWithoutStdio,
      ) => ChildProcessWithoutNullStreams),
): (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams {
  if (typeof processOrFactory === "function") {
    return processOrFactory;
  }

  return () => processOrFactory;
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
  mutableFake.pid = 4321;
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
