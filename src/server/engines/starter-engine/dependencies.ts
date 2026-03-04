/**
 * Dependency construction for the starter-engine plugin.
 *
 * This module wires default runtime adapters, per-process caches, and command
 * probes used for local and remote llama-server flag discovery.
 */
import { spawn } from "node:child_process";
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
  DEFAULT_REMOTE_HELP_CACHE_MAX_ENTRIES,
  DEFAULT_REMOTE_HELP_CACHE_TTL_MS,
  DEFAULT_SERVER_HELP_TIMEOUT_MS,
  DEFAULT_SSH_STARTUP_RETRY_ATTEMPTS,
  DEFAULT_STARTUP_PROBE_WINDOW_MS,
  DEFAULT_STARTUP_RETRY_ATTEMPTS,
  DEFAULT_STOP_GRACE_PERIOD_MS,
  LLAMA_SERVER_COMMAND,
  LOOPBACK_HOST,
} from "./constants.ts";
import {
  captureCommandOutput,
  parseGpuSelectionHints,
  parseSupportedServerFlags,
} from "./help-discovery.ts";
import {
  sweepExpiredCacheEntries,
  trimCacheEntries,
} from "./cache-utils.ts";
import type {
  RemoteGpuSelectionHints,
  StarterLlamaCppPluginDependencies,
} from "./types.ts";
import { delay } from "./utils.ts";

interface RemoteLlamaServerHelpSummary {
  supportedFlags: ReadonlySet<string>;
  gpuSelectionHints: RemoteGpuSelectionHints;
}

export function createDependencies(
  overrides: Partial<StarterLlamaCppPluginDependencies>,
): StarterLlamaCppPluginDependencies {
  // Date.now() is sufficient for short-lived TTL cache freshness checks.
  const now = overrides.now ?? Date.now;
  const executeSshCommandImpl = overrides.executeSshCommand ?? executeSshCommand;
  const remoteHelpCacheTtlMs =
    overrides.remoteHelpCacheTtlMs ?? DEFAULT_REMOTE_HELP_CACHE_TTL_MS;
  const remoteHelpCacheMaxEntries =
    overrides.remoteHelpCacheMaxEntries ?? DEFAULT_REMOTE_HELP_CACHE_MAX_ENTRIES;

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
      const summary = await discoverRemoteLlamaServerHelpSummary(profile, executeSshCommandImpl);
      return summary.supportedFlags;
    });
  const discoverRemoteGpuSelectionHintsImpl =
    overrides.discoverRemoteGpuSelectionHints ??
    (async (profile: TargetProfile) => {
      const summary = await discoverRemoteLlamaServerHelpSummary(profile, executeSshCommandImpl);
      return summary.gpuSelectionHints;
    });

  const useSharedRemoteHelpSummaryCache =
    !overrides.discoverRemoteSupportedServerFlags &&
    !overrides.discoverRemoteGpuSelectionHints;

  const discoverRemoteHelpSummaryDirect = async (
    profile: TargetProfile,
  ): Promise<RemoteLlamaServerHelpSummary> => {
    if (
      !overrides.discoverRemoteSupportedServerFlags &&
      !overrides.discoverRemoteGpuSelectionHints
    ) {
      return discoverRemoteLlamaServerHelpSummary(profile, executeSshCommandImpl);
    }

    const [supportedFlags, gpuSelectionHints] = await Promise.all([
      discoverRemoteSupportedServerFlagsImpl(profile),
      discoverRemoteGpuSelectionHintsImpl(profile),
    ]);

    return {
      supportedFlags,
      gpuSelectionHints,
    };
  };

  const remoteHelpSummaryCache = new Map<
    string,
    {
      expiresAt: number;
      value: RemoteLlamaServerHelpSummary;
    }
  >();
  const remoteHelpSummaryDiscoveryInFlight = new Map<
    string,
    Promise<RemoteLlamaServerHelpSummary>
  >();

  const discoverRemoteHelpSummaryWithCache = async (
    profile: TargetProfile,
  ): Promise<RemoteLlamaServerHelpSummary> => {
    const cacheKey = buildRemoteHelpCacheKey(profile);
    const nowMs = now();
    sweepExpiredCacheEntries(remoteHelpSummaryCache, nowMs);

    const cached = remoteHelpSummaryCache.get(cacheKey);
    if (cached) {
      return cached.value;
    }

    const inFlight = remoteHelpSummaryDiscoveryInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    // Failed discoveries are intentionally not cached. Concurrent callers will
    // observe the same rejection, and the next call retries fresh discovery.
    const discoveryPromise = discoverRemoteHelpSummaryDirect(profile)
      .then((summary) => {
        const discoveryCompletedAtMs = now();
        sweepExpiredCacheEntries(remoteHelpSummaryCache, discoveryCompletedAtMs);
        remoteHelpSummaryCache.set(cacheKey, {
          expiresAt: discoveryCompletedAtMs + remoteHelpCacheTtlMs,
          value: summary,
        });
        trimCacheEntries(remoteHelpSummaryCache, remoteHelpCacheMaxEntries);
        return summary;
      })
      .finally(() => {
        remoteHelpSummaryDiscoveryInFlight.delete(cacheKey);
      });

    remoteHelpSummaryDiscoveryInFlight.set(cacheKey, discoveryPromise);
    return discoveryPromise;
  };

  const remoteSupportedFlagCache = new Map<
    string,
    {
      expiresAt: number;
      value: ReadonlySet<string>;
    }
  >();
  const remoteSupportedFlagDiscoveryInFlight = new Map<
    string,
    Promise<ReadonlySet<string>>
  >();

  const discoverRemoteSupportedServerFlagsOnlyWithCache = async (
    profile: TargetProfile,
  ): Promise<ReadonlySet<string>> => {
    const cacheKey = buildRemoteHelpCacheKey(profile);
    const nowMs = now();
    sweepExpiredCacheEntries(remoteSupportedFlagCache, nowMs);

    const cached = remoteSupportedFlagCache.get(cacheKey);
    if (cached) {
      return cached.value;
    }

    const inFlight = remoteSupportedFlagDiscoveryInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const discoveryPromise = discoverRemoteSupportedServerFlagsImpl(profile)
      .then((supportedFlags) => {
        const completedAtMs = now();
        sweepExpiredCacheEntries(remoteSupportedFlagCache, completedAtMs);
        remoteSupportedFlagCache.set(cacheKey, {
          expiresAt: completedAtMs + remoteHelpCacheTtlMs,
          value: supportedFlags,
        });
        trimCacheEntries(remoteSupportedFlagCache, remoteHelpCacheMaxEntries);
        return supportedFlags;
      })
      .finally(() => {
        remoteSupportedFlagDiscoveryInFlight.delete(cacheKey);
      });

    remoteSupportedFlagDiscoveryInFlight.set(cacheKey, discoveryPromise);
    return discoveryPromise;
  };

  const remoteGpuSelectionHintsCache = new Map<
    string,
    {
      expiresAt: number;
      value: RemoteGpuSelectionHints;
    }
  >();
  const remoteGpuSelectionHintsDiscoveryInFlight =
    new Map<string, Promise<RemoteGpuSelectionHints>>();

  const discoverRemoteGpuSelectionHintsOnlyWithCache = async (
    profile: TargetProfile,
  ): Promise<RemoteGpuSelectionHints> => {
    const cacheKey = buildRemoteHelpCacheKey(profile);
    const nowMs = now();
    sweepExpiredCacheEntries(remoteGpuSelectionHintsCache, nowMs);

    const cached = remoteGpuSelectionHintsCache.get(cacheKey);
    if (cached) {
      return cached.value;
    }

    const inFlight = remoteGpuSelectionHintsDiscoveryInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const discoveryPromise = discoverRemoteGpuSelectionHintsImpl(profile)
      .then((gpuSelectionHints) => {
        const completedAtMs = now();
        sweepExpiredCacheEntries(remoteGpuSelectionHintsCache, completedAtMs);
        remoteGpuSelectionHintsCache.set(cacheKey, {
          expiresAt: completedAtMs + remoteHelpCacheTtlMs,
          value: gpuSelectionHints,
        });
        trimCacheEntries(remoteGpuSelectionHintsCache, remoteHelpCacheMaxEntries);
        return gpuSelectionHints;
      })
      .finally(() => {
        remoteGpuSelectionHintsDiscoveryInFlight.delete(cacheKey);
      });

    remoteGpuSelectionHintsDiscoveryInFlight.set(cacheKey, discoveryPromise);
    return discoveryPromise;
  };

  const discoverRemoteSupportedServerFlagsWithCache = async (
    profile: TargetProfile,
  ): Promise<ReadonlySet<string>> => {
    if (useSharedRemoteHelpSummaryCache) {
      const summary = await discoverRemoteHelpSummaryWithCache(profile);
      return summary.supportedFlags;
    }

    return discoverRemoteSupportedServerFlagsOnlyWithCache(profile);
  };

  const discoverRemoteGpuSelectionHintsWithCache = async (
    profile: TargetProfile,
  ): Promise<RemoteGpuSelectionHints> => {
    if (useSharedRemoteHelpSummaryCache) {
      const summary = await discoverRemoteHelpSummaryWithCache(profile);
      return summary.gpuSelectionHints;
    }

    return discoverRemoteGpuSelectionHintsOnlyWithCache(profile);
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
    discoverRemoteGpuSelectionHints: discoverRemoteGpuSelectionHintsWithCache,
    executeSshCommand: executeSshCommandImpl,
    fetch: overrides.fetch ?? fetch,
    wait: overrides.wait ?? delay,
    now,
    logInfo: overrides.logInfo ?? console.log,
    startupProbeWindowMs:
      overrides.startupProbeWindowMs ?? DEFAULT_STARTUP_PROBE_WINDOW_MS,
    startupRetryAttempts:
      overrides.startupRetryAttempts ?? DEFAULT_STARTUP_RETRY_ATTEMPTS,
    sshStartupRetryAttempts:
      overrides.sshStartupRetryAttempts ?? DEFAULT_SSH_STARTUP_RETRY_ATTEMPTS,
    remoteHelpCacheTtlMs,
    remoteHelpCacheMaxEntries,
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

async function discoverRemoteLlamaServerHelpSummary(
  profile: TargetProfile,
  runSshCommand: StarterLlamaCppPluginDependencies["executeSshCommand"],
): Promise<{
  supportedFlags: ReadonlySet<string>;
  gpuSelectionHints: RemoteGpuSelectionHints;
}> {
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

  const combinedHelpOutput = `${commandResult.stdoutExcerpt}\n${commandResult.stderrExcerpt}`;
  const supportedFlags = parseSupportedServerFlags(combinedHelpOutput);
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

  return {
    supportedFlags,
    gpuSelectionHints: parseGpuSelectionHints(combinedHelpOutput),
  };
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
