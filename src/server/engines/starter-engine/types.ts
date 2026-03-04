import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import type {
  EngineValidationIssue,
  EngineRuntimeContext,
} from "../engine-plugin.ts";
import type { StarterSshLaunchMetadata } from "../starter-engine-ssh.ts";
import type { executeSshCommand } from "../../ssh/ssh-exec.ts";
import type { TargetProfile } from "../../targets/target-profile.ts";

export interface ProcessTerminationExit {
  kind: "exit";
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ProcessTerminationError {
  kind: "error";
  error: Error;
}

export type ProcessTermination = ProcessTerminationExit | ProcessTerminationError;

export interface LlamaServerRunState {
  mode: "local" | "ssh";
  process: ChildProcessWithoutNullStreams;
  terminationPromise: Promise<ProcessTermination>;
  stdoutBuffer: RollingTextBuffer;
  stderrBuffer: RollingTextBuffer;
  healthUrl: string;
  healthRequestHeaders: Record<string, string>;
  apiKey: string;
  remotePortReservation?: {
    destinationKey: string;
    remotePort: number;
  };
  sshManagedRuntime?: {
    profile: TargetProfile;
    remotePort: number;
  };
  startupDiagnosticData?: Record<string, unknown>;
  removeAbortListener: () => void;
}

export interface LlamaServerStartupFailure {
  reason: string;
  stdoutExcerpt: string;
  stderrExcerpt: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface SpawnAttemptSuccess {
  ok: true;
  state: Pick<
    LlamaServerRunState,
    "process" | "terminationPromise" | "stdoutBuffer" | "stderrBuffer"
  >;
}

export interface SpawnAttemptFailure {
  ok: false;
  failure: LlamaServerStartupFailure;
}

export type SpawnAttemptResult = SpawnAttemptSuccess | SpawnAttemptFailure;

export interface StopRunStateInput {
  runId: string;
  reason: string;
  emitDiagnostic: EngineRuntimeContext["emitDiagnostic"];
  dependencies: StarterLlamaCppPluginDependencies;
}

export interface SpawnAttemptInput {
  command: string;
  args: string[];
  environmentOverrides?: Record<string, string>;
  runId: string;
  apiKey: string;
  dependencies: StarterLlamaCppPluginDependencies;
}

export interface StartSshLlamaServerInput {
  runId: string;
  launchMetadata: StarterSshLaunchMetadata;
  emitDiagnostic: EngineRuntimeContext["emitDiagnostic"];
  dependencies: StarterLlamaCppPluginDependencies;
}

export interface RemoteGpuSelectionHints {
  gpuDeviceCount: number;
  mainGpuIndices: readonly number[];
  // Parsed from constrained backend+index tokens (for example ROCm0/CUDA1)
  // from llama-server help output; these are safe to surface in guidance.
  deviceIdentifiers: readonly string[];
}

export interface StarterLlamaCppPluginDependencies {
  spawnProcess: (
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  allocateLoopbackPort: () => Promise<number>;
  createApiKey: () => string;
  modelRoots: readonly string[];
  signalProcessGroup: (pid: number, signal: NodeJS.Signals) => void;
  getTargetProfile: (profileId: string) => Promise<TargetProfile>;
  discoverSupportedServerFlags: () => Promise<ReadonlySet<string>>;
  discoverRemoteSupportedServerFlags: (
    profile: TargetProfile,
  ) => Promise<ReadonlySet<string>>;
  discoverRemoteGpuSelectionHints: (
    profile: TargetProfile,
  ) => Promise<RemoteGpuSelectionHints>;
  executeSshCommand: typeof executeSshCommand;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  wait: (ms: number) => Promise<void>;
  now: () => number;
  logInfo: (message: string) => void;
  startupProbeWindowMs: number;
  startupRetryAttempts: number;
  sshStartupRetryAttempts: number;
  remoteHelpCacheTtlMs: number;
  remoteHelpCacheMaxEntries: number;
  allocateRemoteSshPort: () => number;
  reserveRemoteSshPort: (destinationKey: string, remotePort: number) => boolean;
  releaseRemoteSshPort: (destinationKey: string, remotePort: number) => void;
  stopGracePeriodMs: number;
  killWaitTimeoutMs: number;
  readinessPollIntervalMs: number;
  readinessTimeoutMs: number;
  readinessRequestTimeoutMs: number;
  bufferedLogChars: number;
  diagnosticExcerptChars: number;
}

export interface ReadinessProbeSuccess {
  kind: "ready";
}

export interface ReadinessProbeRetry {
  kind: "retry";
}

export interface ReadinessProbeFailure {
  kind: "failed";
  reason: string;
}

export type ReadinessProbeResult =
  | ReadinessProbeSuccess
  | ReadinessProbeRetry
  | ReadinessProbeFailure;

export interface ServerArgsValidationResult {
  issues: EngineValidationIssue[];
  strictFlagDiscoveryFailed: boolean;
}

export interface ModelIdentifierValidationSuccess {
  ok: true;
  normalizedIdentifier: string;
}

export interface ModelIdentifierValidationFailure {
  ok: false;
  issues: EngineValidationIssue[];
}

export type ModelIdentifierValidationResult =
  | ModelIdentifierValidationSuccess
  | ModelIdentifierValidationFailure;

export class RollingTextBuffer {
  private value = "";

  constructor(private readonly maxChars: number) {}

  append(chunk: string): void {
    if (chunk.length === 0) {
      return;
    }

    this.value += chunk;
    if (this.value.length > this.maxChars) {
      this.value = this.value.slice(-this.maxChars);
    }
  }

  excerpt(maxChars: number): string {
    if (this.value.length <= maxChars) {
      return this.value.trim();
    }

    return this.value.slice(-maxChars).trim();
  }
}
