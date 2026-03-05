/**
 * SSH remote cleanup helpers for starter-engine run shutdown.
 *
 * These routines issue targeted remote `pkill` commands to avoid orphaned
 * llama-server processes when SSH-managed runs stop or fail mid-lifecycle.
 */
import type { TargetProfile } from "../../../targets/target-profile.ts";
import { LOOPBACK_HOST } from "../constants.ts";
import type {
  LlamaServerRunState,
  StopRunStateInput,
} from "../types.ts";
import { redactSecret, toError } from "../utils.ts";

const REMOTE_CLEANUP_MAX_BUFFERED_CHARS = 1_024;
const REMOTE_CLEANUP_DIAGNOSTIC_EXCERPT_CHARS = 512;

type RemoteCleanupSignal = "SIGTERM" | "SIGKILL";

type RemoteCleanupDispatchResult =
  | {
      kind: "matched";
    }
  | {
      kind: "no-match";
    }
  | {
      kind: "unknown";
    };

export async function cleanupRemoteSshRuntime(
  runState: LlamaServerRunState,
  input: StopRunStateInput,
): Promise<void> {
  const metadata = resolveRemoteCleanupMetadata(runState, input);
  if (!metadata) {
    return;
  }

  const termResult = await runRemoteCleanupSignal({
    signal: "SIGTERM",
    pattern: metadata.pattern,
    remotePort: metadata.remotePort,
    profile: metadata.profile,
    runStateApiKey: runState.apiKey,
    stopInput: input,
  });
  if (termResult.kind !== "matched") {
    return;
  }

  await input.dependencies.wait(input.dependencies.remoteCleanupGracePeriodMs);

  const processAlive = await checkRemoteLlamaServerAlive({
    pattern: metadata.pattern,
    remotePort: metadata.remotePort,
    profile: metadata.profile,
    runStateApiKey: runState.apiKey,
    stopInput: input,
  });
  if (processAlive !== true) {
    return;
  }

  await runRemoteCleanupSignal({
    signal: "SIGKILL",
    pattern: metadata.pattern,
    remotePort: metadata.remotePort,
    profile: metadata.profile,
    runStateApiKey: runState.apiKey,
    stopInput: input,
  });
}

async function runRemoteCleanupSignal(input: {
  signal: RemoteCleanupSignal;
  pattern: string;
  profile: TargetProfile;
  remotePort: number;
  runStateApiKey: string;
  stopInput: StopRunStateInput;
}): Promise<RemoteCleanupDispatchResult> {
  const { signal, pattern, profile, remotePort, runStateApiKey, stopInput } = input;

  try {
    const result = await stopInput.dependencies.executeSshCommand({
      profile,
      remoteArgv: ["pkill", toPkillSignalFlag(signal), "-f", pattern],
      allowNonZeroExit: true,
      overallTimeoutMs: stopInput.dependencies.remoteCleanupCommandTimeoutMs,
      maxBufferedChars: REMOTE_CLEANUP_MAX_BUFFERED_CHARS,
      diagnosticExcerptChars: REMOTE_CLEANUP_DIAGNOSTIC_EXCERPT_CHARS,
    });

    const exitCode = result.exitCode;
    const commandSignal = result.signal;

    if (exitCode === 0) {
      stopInput.emitDiagnostic?.({
        level: "info",
        message: "SSH remote llama-server cleanup signal dispatched.",
        data: {
          runId: stopInput.runId,
          signal,
          remotePort,
        },
      });
      return {
        kind: "matched",
      };
    }

    if (exitCode === 1) {
      stopInput.emitDiagnostic?.({
        level: "info",
        message: "SSH remote cleanup found no matching llama-server process.",
        data: {
          runId: stopInput.runId,
          signal,
          remotePort,
        },
      });
      return {
        kind: "no-match",
      };
    }

    stopInput.emitDiagnostic?.({
      level: "warn",
      message: "SSH remote llama-server cleanup signal had indeterminate result.",
      data: {
        runId: stopInput.runId,
        signal,
        remotePort,
        ...(exitCode !== null
          ? {
              exitCode,
            }
          : {}),
        ...(commandSignal !== null
          ? {
              commandSignal,
            }
          : {}),
      },
    });

    return {
      kind: "unknown",
    };
  } catch (error) {
    stopInput.emitDiagnostic?.({
      level: "warn",
      message: "SSH remote llama-server cleanup command failed.",
      data: {
        runId: stopInput.runId,
        signal,
        remotePort,
        reason: redactSecret(toError(error).message, runStateApiKey),
      },
    });
    return {
      kind: "unknown",
    };
  }
}

async function checkRemoteLlamaServerAlive(input: {
  pattern: string;
  profile: TargetProfile;
  remotePort: number;
  runStateApiKey: string;
  stopInput: StopRunStateInput;
}): Promise<boolean | null> {
  try {
    const result = await input.stopInput.dependencies.executeSshCommand({
      profile: input.profile,
      remoteArgv: ["pgrep", "-f", input.pattern],
      allowNonZeroExit: true,
      overallTimeoutMs: input.stopInput.dependencies.remoteCleanupCommandTimeoutMs,
      maxBufferedChars: REMOTE_CLEANUP_MAX_BUFFERED_CHARS,
      diagnosticExcerptChars: REMOTE_CLEANUP_DIAGNOSTIC_EXCERPT_CHARS,
    });

    if (result.exitCode === 0) {
      return true;
    }

    if (result.exitCode === 1) {
      return false;
    }

    input.stopInput.emitDiagnostic?.({
      level: "warn",
      message: "SSH remote llama-server liveness check returned an indeterminate status.",
      data: {
        runId: input.stopInput.runId,
        remotePort: input.remotePort,
        ...(result.exitCode !== null
          ? {
              exitCode: result.exitCode,
            }
          : {}),
        ...(result.signal !== null
          ? {
              commandSignal: result.signal,
            }
          : {}),
      },
    });
    return null;
  } catch (error) {
    input.stopInput.emitDiagnostic?.({
      level: "warn",
      message: "SSH remote llama-server liveness check failed.",
      data: {
        runId: input.stopInput.runId,
        remotePort: input.remotePort,
        reason: redactSecret(toError(error).message, input.runStateApiKey),
      },
    });
    return null;
  }
}

function resolveRemoteCleanupMetadata(
  runState: LlamaServerRunState,
  input: StopRunStateInput,
): {
  profile: TargetProfile;
  remotePort: number;
  pattern: string;
} | null {
  if (runState.mode !== "ssh") {
    return null;
  }

  if (!runState.sshManagedRuntime) {
    input.emitDiagnostic?.({
      level: "warn",
      message: "Skipping SSH remote cleanup because SSH runtime profile metadata is unavailable.",
      data: {
        runId: input.runId,
      },
    });
    return null;
  }

  const remotePort = runState.remotePortReservation?.remotePort;
  if (remotePort === undefined) {
    input.emitDiagnostic?.({
      level: "warn",
      message: "Skipping SSH remote cleanup because remote port metadata is unavailable.",
      data: {
        runId: input.runId,
      },
    });
    return null;
  }

  return {
    profile: runState.sshManagedRuntime.profile,
    remotePort,
    pattern: buildRemoteLlamaServerPattern({
      remotePort,
      apiKey: runState.apiKey,
    }),
  };
}

function buildRemoteLlamaServerPattern(input: {
  remotePort: number;
  apiKey: string;
}): string {
  const escapedHost = escapeRegex(LOOPBACK_HOST);
  const escapedPort = escapeRegex(String(input.remotePort));
  const escapedApiKey = escapeRegex(input.apiKey);
  const whitespaceClass = "[[:space:]]";

  // `pkill -f` and `pgrep -f` generally evaluate POSIX ERE patterns, where
  // `\s` is not a portable whitespace token.
  return (
    `(^|/)llama-server(${whitespaceClass}|$).*` +
    `--host ${escapedHost} --port ${escapedPort} --api-key ${escapedApiKey} --no-webui(${whitespaceClass}|$)`
  );
}

function toPkillSignalFlag(signal: RemoteCleanupSignal): string {
  return signal === "SIGTERM" ? "-TERM" : "-KILL";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
