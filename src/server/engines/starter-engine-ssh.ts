import { randomInt } from "node:crypto";
import {
  buildSshBaseConnectionParts,
  type SshTargetConnection,
} from "../ssh/ssh-exec.ts";
import { buildPosixShellCommand } from "../ssh/posix-shell.ts";
import type { TargetProfile } from "../targets/target-profile.ts";

export const SSH_REMOTE_PORT_MIN = 18_000;
export const SSH_REMOTE_PORT_MAX = 28_000;

const LOOPBACK_HOST = "127.0.0.1";
const RETRYABLE_REMOTE_STARTUP_PATTERN =
  /address already in use|eaddrinuse|failed to bind|cannot bind|bind\(|listen\(/i;
const LIKELY_SSH_TRANSPORT_FAILURE_PATTERN =
  /permission denied|host key verification failed|remote host identification has changed|could not resolve hostname|connection timed out|operation timed out|no route to host|network is unreachable|connection refused|kex_exchange_identification|connection closed by remote host|ssh: connect to host/i;

export interface StarterSshLaunchMetadata {
  mode: "ssh";
  profile: TargetProfile;
  modelIdentifier: string;
  serverArgs: string[];
}

interface SshMetadataRecordAuth {
  method?: unknown;
  privateKeyPath?: unknown;
}

export function createStarterSshLaunchMetadata(input: {
  profile: TargetProfile;
  modelIdentifier: string;
  serverArgs: readonly string[];
}): StarterSshLaunchMetadata {
  return {
    mode: "ssh",
    profile: input.profile,
    modelIdentifier: input.modelIdentifier,
    serverArgs: [...input.serverArgs],
  };
}

export function serializeStarterSshLaunchMetadata(
  metadata: StarterSshLaunchMetadata,
): Record<string, unknown> {
  return {
    mode: metadata.mode,
    profile: {
      schemaVersion: metadata.profile.schemaVersion,
      id: metadata.profile.id,
      displayName: metadata.profile.displayName,
      host: metadata.profile.host,
      port: metadata.profile.port,
      username: metadata.profile.username,
      auth:
        metadata.profile.auth.method === "key-path"
          ? {
              method: "key-path",
              privateKeyPath: metadata.profile.auth.privateKeyPath,
            }
          : {
              method: "ssh-agent",
            },
      remoteModelRoots: [...metadata.profile.remoteModelRoots],
      llamaServerPath: metadata.profile.llamaServerPath,
    },
    modelIdentifier: metadata.modelIdentifier,
    serverArgs: [...metadata.serverArgs],
  };
}

export function isStarterSshLaunchMetadata(
  value: unknown,
): value is StarterSshLaunchMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as {
    mode?: unknown;
    profile?: unknown;
    modelIdentifier?: unknown;
    serverArgs?: unknown;
  };

  if (candidate.mode !== "ssh") {
    return false;
  }

  if (typeof candidate.modelIdentifier !== "string") {
    return false;
  }

  if (!Array.isArray(candidate.serverArgs)) {
    return false;
  }

  const profile = candidate.profile as
    | {
        id?: unknown;
        host?: unknown;
        port?: unknown;
        username?: unknown;
        auth?: unknown;
        llamaServerPath?: unknown;
      }
    | undefined;

  if (!profile || typeof profile !== "object") {
    return false;
  }

  const auth = profile.auth as SshMetadataRecordAuth | undefined;
  const hasValidAuthMethod =
    auth?.method === "ssh-agent" ||
    (auth?.method === "key-path" && typeof auth.privateKeyPath === "string");

  return (
    typeof profile.id === "string" &&
    typeof profile.host === "string" &&
    typeof profile.port === "number" &&
    typeof profile.username === "string" &&
    typeof profile.llamaServerPath === "string" &&
    hasValidAuthMethod
  );
}

export function buildRemoteHelpCacheKey(profile: TargetProfile): string {
  const privateKeyPart =
    profile.auth.method === "key-path" ? profile.auth.privateKeyPath : "ssh-agent";
  return [
    profile.id,
    profile.host,
    String(profile.port),
    profile.username,
    privateKeyPart,
    profile.llamaServerPath,
  ].join("\u0000");
}

export function buildRemotePortReservationKey(profile: TargetProfile): string {
  return [profile.host, String(profile.port), profile.username].join("\u0000");
}

export function buildSshManagedLaunchArgv(input: {
  profile: TargetProfile;
  localPort: number;
  remotePort: number;
  modelIdentifier: string;
  serverArgs: readonly string[];
  apiKey: string;
}): {
  argv: string[];
  destination: string;
} {
  assertPortInRange(input.localPort, "localPort");
  assertPortInRange(input.remotePort, "remotePort");

  const connection = buildSshBaseConnectionParts(toSshTargetConnection(input.profile));
  const remoteArgv = [
    input.profile.llamaServerPath,
    "--model",
    input.modelIdentifier,
    "--host",
    LOOPBACK_HOST,
    "--port",
    String(input.remotePort),
    "--api-key",
    input.apiKey,
    "--no-webui",
    ...input.serverArgs,
  ];

  const remoteCommand = `exec ${buildPosixShellCommand(remoteArgv)}`;

  return {
    argv: [
      connection.command,
      ...connection.optionsArgv,
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      `${LOOPBACK_HOST}:${input.localPort}:${LOOPBACK_HOST}:${input.remotePort}`,
      connection.destination,
      remoteCommand,
    ],
    destination: connection.destination,
  };
}

export function allocateRandomSshRemotePort(
  minPort: number = SSH_REMOTE_PORT_MIN,
  maxPort: number = SSH_REMOTE_PORT_MAX,
): number {
  assertPortInRange(minPort, "minPort");
  assertPortInRange(maxPort, "maxPort");
  if (minPort > maxPort) {
    throw new Error("minPort must be <= maxPort.");
  }

  return randomInt(minPort, maxPort + 1);
}

export function isRetryableRemoteStartupFailure(reason: string): boolean {
  return RETRYABLE_REMOTE_STARTUP_PATTERN.test(reason);
}

export function isLikelySshTransportFailure(reason: string): boolean {
  return LIKELY_SSH_TRANSPORT_FAILURE_PATTERN.test(reason);
}

export function getMissingRequiredRemoteHelpFlags(
  supportedFlags: ReadonlySet<string>,
): string[] {
  const required = ["--no-webui", "--model", "--host", "--port"];
  const missing = required.filter((flag) => !supportedFlags.has(flag));

  if (!supportedFlags.has("--api-key") && !supportedFlags.has("--api_key")) {
    missing.push("--api-key|--api_key");
  }

  return missing;
}

function toSshTargetConnection(profile: TargetProfile): SshTargetConnection {
  return {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    auth: profile.auth,
  };
}

function assertPortInRange(port: number, fieldName: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${fieldName} must be an integer between 1 and 65535.`);
  }
}
