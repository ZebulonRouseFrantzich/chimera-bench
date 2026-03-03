/**
 * Dependency construction for the starter-engine plugin.
 *
 * This module wires default runtime adapters, per-process caches, and command
 * probes used for local and remote llama-server flag discovery.
 */
import { spawn } from "node:child_process";
import type {
  ChildProcess,
  ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import {
  allocateRandomSshRemotePort,
  buildRemoteHelpCacheKey,
  getMissingRequiredRemoteHelpFlags,
} from "../starter-engine-ssh.ts";
import {
  executeSshCommand,
  SshCommandExecutionError,
} from "../../ssh/ssh-exec.ts";
import type { TargetProfile } from "../../targets/target-profile.ts";
import {
  API_KEY_ENTROPY_BYTES,
  DEFAULT_BUFFERED_LOG_CHARS,
  DEFAULT_DIAGNOSTIC_EXCERPT_CHARS,
  DEFAULT_KILL_WAIT_TIMEOUT_MS,
  DEFAULT_MAX_HELP_OUTPUT_CHARS,
  DEFAULT_READINESS_POLL_INTERVAL_MS,
  DEFAULT_READINESS_REQUEST_TIMEOUT_MS,
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_REMOTE_HELP_CACHE_TTL_MS,
  DEFAULT_SERVER_HELP_TIMEOUT_MS,
  DEFAULT_SSH_STARTUP_RETRY_ATTEMPTS,
  DEFAULT_STARTUP_PROBE_WINDOW_MS,
  DEFAULT_STARTUP_RETRY_ATTEMPTS,
  DEFAULT_STOP_GRACE_PERIOD_MS,
  LLAMA_SERVER_COMMAND,
  LOOPBACK_HOST,
} from "./constants.ts";
import type { StarterLlamaCppPluginDependencies } from "./types.ts";
import { delay, toError } from "./utils.ts";

export function createDependencies(
  overrides: Partial<StarterLlamaCppPluginDependencies>,
): StarterLlamaCppPluginDependencies {
  const now = overrides.now ?? Date.now;
  const executeSshCommandImpl = overrides.executeSshCommand ?? executeSshCommand;
  const remoteHelpCacheTtlMs =
    overrides.remoteHelpCacheTtlMs ?? DEFAULT_REMOTE_HELP_CACHE_TTL_MS;

  const discoverSupportedServerFlagsImpl =
    overrides.discoverSupportedServerFlags ?? discoverSupportedServerFlags;
  let cachedSupportedServerFlagsPromise: Promise<ReadonlySet<string>> | null = null;

  const discoverSupportedServerFlagsWithCache = async (): Promise<ReadonlySet<string>> => {
    if (!cachedSupportedServerFlagsPromise) {
      cachedSupportedServerFlagsPromise = discoverSupportedServerFlagsImpl().catch(
        (error: unknown) => {
          cachedSupportedServerFlagsPromise = null;
          throw error;
        },
      );
    }

    return cachedSupportedServerFlagsPromise;
  };

  const discoverRemoteSupportedServerFlagsImpl =
    overrides.discoverRemoteSupportedServerFlags ??
    (async (profile: TargetProfile) => {
      return discoverRemoteSupportedServerFlags(profile, executeSshCommandImpl);
    });
  const remoteSupportedFlagCache = new Map<
    string,
    {
      expiresAt: number;
      supportedFlags: ReadonlySet<string>;
    }
  >();
  const remoteDiscoveryInFlight = new Map<string, Promise<ReadonlySet<string>>>();

  const discoverRemoteSupportedServerFlagsWithCache = async (
    profile: TargetProfile,
  ): Promise<ReadonlySet<string>> => {
    const cacheKey = buildRemoteHelpCacheKey(profile);
    const cached = remoteSupportedFlagCache.get(cacheKey);
    const nowMs = now();
    if (cached && cached.expiresAt > nowMs) {
      return cached.supportedFlags;
    }

    const inFlight = remoteDiscoveryInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    // Failed discoveries are intentionally not cached. Concurrent callers will
    // observe the same rejection, and the next call retries fresh discovery.
    const discoveryPromise = discoverRemoteSupportedServerFlagsImpl(profile)
      .then((supportedFlags) => {
        remoteSupportedFlagCache.set(cacheKey, {
          expiresAt: now() + remoteHelpCacheTtlMs,
          supportedFlags,
        });
        return supportedFlags;
      })
      .finally(() => {
        remoteDiscoveryInFlight.delete(cacheKey);
      });

    remoteDiscoveryInFlight.set(cacheKey, discoveryPromise);
    return discoveryPromise;
  };

  const reservedRemotePortsByDestination = new Map<string, Set<number>>();
  const reserveRemoteSshPort = (destinationKey: string, remotePort: number): boolean => {
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      return false;
    }

    const existing = reservedRemotePortsByDestination.get(destinationKey);
    if (existing?.has(remotePort)) {
      return false;
    }

    if (existing) {
      existing.add(remotePort);
      return true;
    }

    reservedRemotePortsByDestination.set(destinationKey, new Set([remotePort]));
    return true;
  };

  const releaseRemoteSshPort = (destinationKey: string, remotePort: number): void => {
    const existing = reservedRemotePortsByDestination.get(destinationKey);
    if (!existing) {
      return;
    }

    existing.delete(remotePort);
    if (existing.size === 0) {
      reservedRemotePortsByDestination.delete(destinationKey);
    }
  };

  return {
    spawnProcess: overrides.spawnProcess ?? spawn,
    allocateLoopbackPort: overrides.allocateLoopbackPort ?? allocateLoopbackPort,
    allocateRemoteSshPort:
      overrides.allocateRemoteSshPort ?? (() => allocateRandomSshRemotePort()),
    createApiKey:
      overrides.createApiKey ??
      (() => randomBytes(API_KEY_ENTROPY_BYTES).toString("base64url")),
    modelRoots: overrides.modelRoots ? [...overrides.modelRoots] : [],
    signalProcessGroup:
      overrides.signalProcessGroup ??
      ((pid, signal) => {
        process.kill(-pid, signal);
      }),
    getTargetProfile:
      overrides.getTargetProfile ??
      (async (profileId: string) => {
        throw new Error(
          `SSH target profile '${profileId}' could not be resolved by llama.cpp plugin dependencies.`,
        );
      }),
    discoverSupportedServerFlags: discoverSupportedServerFlagsWithCache,
    discoverRemoteSupportedServerFlags: discoverRemoteSupportedServerFlagsWithCache,
    executeSshCommand: executeSshCommandImpl,
    fetch: overrides.fetch ?? fetch,
    wait: overrides.wait ?? delay,
    now,
    startupProbeWindowMs:
      overrides.startupProbeWindowMs ?? DEFAULT_STARTUP_PROBE_WINDOW_MS,
    startupRetryAttempts:
      overrides.startupRetryAttempts ?? DEFAULT_STARTUP_RETRY_ATTEMPTS,
    sshStartupRetryAttempts:
      overrides.sshStartupRetryAttempts ?? DEFAULT_SSH_STARTUP_RETRY_ATTEMPTS,
    remoteHelpCacheTtlMs,
    reserveRemoteSshPort: overrides.reserveRemoteSshPort ?? reserveRemoteSshPort,
    releaseRemoteSshPort: overrides.releaseRemoteSshPort ?? releaseRemoteSshPort,
    stopGracePeriodMs: overrides.stopGracePeriodMs ?? DEFAULT_STOP_GRACE_PERIOD_MS,
    killWaitTimeoutMs: overrides.killWaitTimeoutMs ?? DEFAULT_KILL_WAIT_TIMEOUT_MS,
    readinessPollIntervalMs:
      overrides.readinessPollIntervalMs ?? DEFAULT_READINESS_POLL_INTERVAL_MS,
    readinessTimeoutMs: overrides.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
    readinessRequestTimeoutMs:
      overrides.readinessRequestTimeoutMs ?? DEFAULT_READINESS_REQUEST_TIMEOUT_MS,
    bufferedLogChars: overrides.bufferedLogChars ?? DEFAULT_BUFFERED_LOG_CHARS,
    diagnosticExcerptChars:
      overrides.diagnosticExcerptChars ?? DEFAULT_DIAGNOSTIC_EXCERPT_CHARS,
  };
}

async function discoverSupportedServerFlags(): Promise<ReadonlySet<string>> {
  const output = await captureCommandOutput(
    LLAMA_SERVER_COMMAND,
    ["--help"],
    DEFAULT_SERVER_HELP_TIMEOUT_MS,
    DEFAULT_MAX_HELP_OUTPUT_CHARS,
  );

  const supportedFlags = parseSupportedServerFlags(`${output.stdout}\n${output.stderr}`);
  if (supportedFlags.size > 0) {
    return supportedFlags;
  }

  throw new Error("Unable to parse supported flags from `llama-server --help` output.");
}

async function discoverRemoteSupportedServerFlags(
  profile: TargetProfile,
  runSshCommand: StarterLlamaCppPluginDependencies["executeSshCommand"],
): Promise<ReadonlySet<string>> {
  let commandResult:
    | {
        stdoutExcerpt: string;
        stderrExcerpt: string;
      }
    | undefined;

  try {
    commandResult = await runSshCommand({
      profile: {
        host: profile.host,
        port: profile.port,
        username: profile.username,
        auth: profile.auth,
      },
      remoteArgv: [profile.llamaServerPath, "--help"],
      overallTimeoutMs: DEFAULT_SERVER_HELP_TIMEOUT_MS,
      maxBufferedChars: DEFAULT_MAX_HELP_OUTPUT_CHARS,
      diagnosticExcerptChars: DEFAULT_MAX_HELP_OUTPUT_CHARS,
      allowNonZeroExit: true,
    });
  } catch (error) {
    if (error instanceof SshCommandExecutionError) {
      throw new Error(`Remote llama-server --help discovery failed over SSH. ${error.message}`);
    }

    throw error;
  }

  const supportedFlags = parseSupportedServerFlags(
    `${commandResult.stdoutExcerpt}\n${commandResult.stderrExcerpt}`,
  );
  if (supportedFlags.size === 0) {
    throw new Error("Unable to parse supported flags from remote `llama-server --help` output.");
  }

  const missingRequiredFlags = getMissingRequiredRemoteHelpFlags(supportedFlags);
  if (missingRequiredFlags.length > 0) {
    throw new Error(
      "Remote `llama-server --help` output is missing required flags " +
        `(${missingRequiredFlags.join(", ")}). Verify llamaServerPath points to a compatible binary.`,
    );
  }

  return supportedFlags;
}

async function captureCommandOutput(
  command: string,
  args: string[],
  timeoutMs: number,
  maxCharsPerStream: number,
): Promise<{
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      rejectPromise(toError(error));
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      child.off("error", onError);
      child.off("close", onClose);
    };

    const onError = (error: Error) => {
      cleanup();
      rejectPromise(error);
    };

    const onClose = () => {
      cleanup();

      if (timedOut) {
        rejectPromise(
          new Error(`Timed out after ${timeoutMs}ms while running '${command} ${args.join(" ")}'.`),
        );
        return;
      }

      // Some llama-server builds exit non-zero for --help while still emitting
      // complete flag documentation; callers validate parsed flag content.

      resolvePromise({
        stdout,
        stderr,
      });
    };

    child.once("error", onError);
    child.once("close", onClose);

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string | Buffer) => {
        stdout = appendBounded(stdout, chunk.toString(), maxCharsPerStream);
      });
    }

    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string | Buffer) => {
        stderr = appendBounded(stderr, chunk.toString(), maxCharsPerStream);
      });
    }
  });
}

function parseSupportedServerFlags(helpOutput: string): ReadonlySet<string> {
  const supportedFlags = new Set<string>();
  const flagPattern = /(?:^|\s)(--[a-z0-9][a-z0-9-]*|-[a-z0-9])(?=\s|=|,|\]|$)/gi;

  for (const match of helpOutput.matchAll(flagPattern)) {
    const flag = match[1]?.trim().toLowerCase();
    if (!flag) {
      continue;
    }

    supportedFlags.add(flag);
  }

  return supportedFlags;
}

function appendBounded(existing: string, nextChunk: string, maxChars: number): string {
  const combined = `${existing}${nextChunk}`;
  if (combined.length <= maxChars) {
    return combined;
  }

  return combined.slice(-maxChars);
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  server.unref();

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      rejectPromise(error);
    };

    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({
      host: LOOPBACK_HOST,
      port: 0,
      exclusive: true,
    });
  });

  const address = server.address();

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) {
        rejectPromise(error);
        return;
      }

      resolvePromise();
    });
  });

  // This has an unavoidable TOCTOU window between releasing the probe socket and
  // the engine process binding. Startup retries handle transient collisions.

  if (!address || typeof address === "string" || address.port <= 0) {
    throw new Error("Unable to allocate a loopback port for llama-server startup.");
  }

  return address.port;
}
