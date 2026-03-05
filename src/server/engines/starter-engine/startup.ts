/**
 * Startup flows for local and SSH-managed starter-engine runs.
 *
 * This module owns launch metadata parsing, retry policies, and user-facing
 * startup error construction with secret redaction.
 */
import type { EngineStartFailedError } from "../engine-plugin.ts";
import { EngineStartFailedError as EngineStartFailedErrorClass } from "../engine-plugin.ts";
import {
  buildRemotePortReservationKey,
  buildSshManagedLaunchArgv,
  isLikelySshTransportFailure,
  isRetryableRemoteStartupFailure,
  isStarterSshLaunchMetadata,
} from "../starter-engine-ssh.ts";
import { classifySshFailureGuidance } from "../../ssh/ssh-exec.ts";
import { MIN_API_KEY_LENGTH, LOOPBACK_HOST } from "./constants.ts";
import { spawnLlamaServerAttempt } from "./spawn.ts";
import type {
  LlamaServerRunState,
  LlamaServerStartupFailure,
  StartSshLlamaServerInput,
} from "./types.ts";
import {
  buildHealthRequestHeaders,
  createCodeError,
  redactLaunchArgs,
  redactSecret,
} from "./utils.ts";

export function parseSshLaunchMetadata(
  metadata: Record<string, unknown> | undefined,
): StartSshLlamaServerInput["launchMetadata"] | null {
  if (!metadata) {
    return null;
  }

  if (!isStarterSshLaunchMetadata(metadata)) {
    return null;
  }

  return metadata;
}

export async function startSshLlamaServerWithRetries(
  input: StartSshLlamaServerInput,
): Promise<LlamaServerRunState> {
  const apiKey = input.dependencies.createApiKey();
  assertApiKeyStrength(apiKey);
  const destinationKey = buildRemotePortReservationKey(input.launchMetadata.profile);
  const attemptedRemotePorts = new Set<number>();

  let lastFailure: LlamaServerStartupFailure | null = null;
  let lastLaunchContext:
    | {
        command: string;
        args: string[];
        localPort: number;
        remotePort: number;
        destination: string;
      }
    | null = null;

  for (let attempt = 1; attempt <= input.dependencies.sshStartupRetryAttempts; attempt += 1) {
    const localPort = await input.dependencies.allocateLoopbackPort();
    const remotePort = reserveUniqueRemoteSshPort({
      destinationKey,
      attemptedRemotePorts,
      dependencies: input.dependencies,
    });
    let reservationOwnedByRunState = false;

    try {
      const launch = buildSshManagedLaunchArgv({
        profile: input.launchMetadata.profile,
        localPort,
        remotePort,
        modelIdentifier: input.launchMetadata.modelIdentifier,
        serverArgs: input.launchMetadata.serverArgs,
        apiKey,
      });

      const [command, ...args] = launch.argv;
      if (!command) {
        throw new Error("SSH launch command argv cannot be empty.");
      }

      input.emitDiagnostic?.({
        level: "info",
        message: "Starting SSH-managed remote llama-server session.",
        data: {
          runId: input.runId,
          profileId: input.launchMetadata.profile.id,
          destination: launch.destination,
          localPort,
          remotePort,
          attempt,
        },
      });

      const attemptResult = await spawnLlamaServerAttempt({
        command,
        args,
        runId: input.runId,
        apiKey,
        dependencies: input.dependencies,
      });

      if (attemptResult.ok) {
        input.emitDiagnostic?.({
          level: "info",
          message: "SSH port-forward established for remote llama-server session.",
          data: {
            runId: input.runId,
            profileId: input.launchMetadata.profile.id,
            destination: launch.destination,
            localPort,
            remotePort,
          },
        });

        reservationOwnedByRunState = true;
        return {
          mode: "ssh",
          ...attemptResult.state,
          healthUrl: `http://${LOOPBACK_HOST}:${localPort}/health`,
          healthRequestHeaders: buildHealthRequestHeaders(apiKey),
          apiKey,
          remotePortReservation: {
            destinationKey,
            remotePort,
          },
          sshManagedRuntime: {
            profile: input.launchMetadata.profile,
          },
          startupDiagnosticData: {
            profileId: input.launchMetadata.profile.id,
            destination: launch.destination,
            localPort,
            remotePort,
          },
          removeAbortListener: () => {
            return;
          },
        };
      }

      lastFailure = attemptResult.failure;
      lastLaunchContext = {
        command,
        args,
        localPort,
        remotePort,
        destination: launch.destination,
      };

      const retryableFailureReason = `${lastFailure.reason}\n${lastFailure.stderrExcerpt}`;
      const shouldRetry =
        attempt < input.dependencies.sshStartupRetryAttempts &&
        isRetryableRemoteStartupFailure(retryableFailureReason);

      if (!shouldRetry) {
        break;
      }

      input.emitDiagnostic?.({
        level: "warn",
        message:
          "Remote llama-server exited during startup; retrying with a new SSH-forwarded remote port.",
        data: {
          runId: input.runId,
          attempt,
          reason: redactSecret(lastFailure.reason, apiKey),
        },
      });
    } finally {
      // Failed attempts must release the reservation here; successful attempts
      // transfer reservation ownership to run-state cleanup.
      if (!reservationOwnedByRunState) {
        input.dependencies.releaseRemoteSshPort(destinationKey, remotePort);
      }
    }
  }

  if (!lastFailure || !lastLaunchContext) {
    throw new Error("SSH-managed remote llama-server startup failed unexpectedly.");
  }

  input.emitDiagnostic?.({
    level: "error",
    message: "SSH-managed remote llama-server failed to start after retries.",
    data: {
      runId: input.runId,
      profileId: input.launchMetadata.profile.id,
      destination: lastLaunchContext.destination,
      localPort: lastLaunchContext.localPort,
      remotePort: lastLaunchContext.remotePort,
      reason: redactSecret(lastFailure.reason, apiKey),
    },
  });

  throw buildSshStartupFailureError({
    runId: input.runId,
    command: lastLaunchContext.command,
    args: lastLaunchContext.args,
    failure: lastFailure,
    apiKey,
    profileId: input.launchMetadata.profile.id,
    destination: lastLaunchContext.destination,
    localPort: lastLaunchContext.localPort,
    remotePort: lastLaunchContext.remotePort,
  });
}

export function assertApiKeyStrength(apiKey: string): void {
  if (apiKey.length < MIN_API_KEY_LENGTH) {
    throw new Error(
      `Generated llama-server API key is too short (${apiKey.length} chars). Expected at least ${MIN_API_KEY_LENGTH} chars (>=32 bytes entropy).`,
    );
  }
}

export function buildStartupFailureError(input: {
  runId: string;
  command: string;
  args: string[];
  failure: LlamaServerStartupFailure;
  apiKey: string;
}): EngineStartFailedError {
  const redactedArgs = redactLaunchArgs(input.args);
  const commandSummary = redactSecret([input.command, ...redactedArgs].join(" "), input.apiKey);
  const details: Record<string, unknown> = {
    code: "ENGINE_START_FAILED",
    reason: redactSecret(input.failure.reason, input.apiKey),
    launchCommand: commandSummary,
  };

  const messageParts: string[] = [];

  messageParts.push(`Unable to start llama-server for run '${input.runId}'. ${details.reason as string}`);

  if (input.failure.stderrExcerpt.length > 0) {
    details.stderrExcerpt = input.failure.stderrExcerpt;
    messageParts.push(`stderr excerpt: ${input.failure.stderrExcerpt}`);
  }

  if (input.failure.stdoutExcerpt.length > 0) {
    details.stdoutExcerpt = input.failure.stdoutExcerpt;
    messageParts.push(`stdout excerpt: ${input.failure.stdoutExcerpt}`);
  }

  if (input.failure.exitCode !== null) {
    details.exitCode = input.failure.exitCode;
  }

  if (input.failure.signal !== null) {
    details.signal = input.failure.signal;
  }

  messageParts.push(`launch command: ${commandSummary}`);

  return new EngineStartFailedErrorClass(`ENGINE_START_FAILED: ${messageParts.join(" ")}`, details);
}

export function isRetryableStartupFailure(failure: LlamaServerStartupFailure): boolean {
  if (failure.exitCode === 48 || failure.exitCode === 98) {
    return true;
  }

  const normalizedReason = `${failure.reason}\n${failure.stderrExcerpt}`.toLowerCase();

  return /address already in use|eaddrinuse|failed to bind|cannot bind|bind\(/.test(
    normalizedReason,
  );
}

function reserveUniqueRemoteSshPort(input: {
  destinationKey: string;
  attemptedRemotePorts: Set<number>;
  dependencies: StartSshLlamaServerInput["dependencies"];
}): number {
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const candidatePort = input.dependencies.allocateRemoteSshPort();
    if (input.attemptedRemotePorts.has(candidatePort)) {
      continue;
    }

    input.attemptedRemotePorts.add(candidatePort);
    if (input.dependencies.reserveRemoteSshPort(input.destinationKey, candidatePort)) {
      return candidatePort;
    }
  }

  throw new Error(
    "Unable to reserve a unique remote SSH port for llama-server startup after 256 attempts.",
  );
}

function buildSshStartupFailureError(input: {
  runId: string;
  command: string;
  args: string[];
  failure: LlamaServerStartupFailure;
  apiKey: string;
  profileId: string;
  destination: string;
  localPort: number;
  remotePort: number;
}): Error {
  const redactedReason = redactSecret(input.failure.reason, input.apiKey);
  const redactedStderrExcerpt = redactSecret(input.failure.stderrExcerpt, input.apiKey);
  const redactedStdoutExcerpt = redactSecret(input.failure.stdoutExcerpt, input.apiKey);
  const combinedFailureReason = `${redactedReason}\n${redactedStderrExcerpt}`;
  const sshGuidance = classifySshFailureGuidance(combinedFailureReason);
  const likelySshFailure =
    sshGuidance !== null || isLikelySshTransportFailure(combinedFailureReason);

  if (!likelySshFailure) {
    return buildStartupFailureError({
      runId: input.runId,
      command: input.command,
      args: input.args,
      failure: {
        ...input.failure,
        reason: redactedReason,
        stderrExcerpt: redactedStderrExcerpt,
        stdoutExcerpt: redactedStdoutExcerpt,
      },
      apiKey: input.apiKey,
    });
  }

  const launchCommand = redactSecret(
    [input.command, ...redactLaunchArgs(input.args)].join(" "),
    input.apiKey,
  );

  const details: Record<string, unknown> = {
    reason: redactedReason,
    launchCommand,
    profileId: input.profileId,
    destination: input.destination,
    localPort: input.localPort,
    remotePort: input.remotePort,
    ...(redactedStderrExcerpt.length > 0
      ? {
          stderrExcerpt: redactedStderrExcerpt,
        }
      : {}),
    ...(redactedStdoutExcerpt.length > 0
      ? {
          stdoutExcerpt: redactedStdoutExcerpt,
        }
      : {}),
    ...(input.failure.exitCode !== null
      ? {
          exitCode: input.failure.exitCode,
        }
      : {}),
    ...(input.failure.signal !== null
      ? {
          signal: input.failure.signal,
        }
      : {}),
  };

  const message =
    `REMOTE_SSH_FAILED: Unable to start SSH-managed remote llama-server for run '${input.runId}'. ` +
    redactedReason +
    (sshGuidance ? ` ${sshGuidance}` : "");

  return createCodeError("REMOTE_SSH_FAILED", message, details);
}
