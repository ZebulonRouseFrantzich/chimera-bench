export type EngineValidationMode = "strict" | "permissive";

export const ENGINE_PLUGIN_API_VERSION = 1;

export class EngineStartFailedError extends Error {
  readonly code = "ENGINE_START_FAILED";

  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "EngineStartFailedError";
  }
}

const RESTRICTED_ENVIRONMENT_OVERRIDE_KEYS = new Set([
  "LD_PRELOAD",
  "LD_AUDIT",
  "NODE_OPTIONS",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FORCE_FLAT_NAMESPACE",
]);

export interface EngineCapabilities {
  chatCompletions: boolean;
  localTarget: boolean;
  streaming: boolean;
}

export interface EngineEnvironmentSummary {
  status: "ok" | "error" | "unknown";
  message?: string;
}

export interface EngineRunConfig {
  engineId: string;
  target: {
    type: "local";
  };
  model: {
    identifier: string;
  };
  workloadId: string;
  validationMode: EngineValidationMode;
  engine: {
    serverArgs: string[];
    requestParams: Record<string, unknown>;
  };
  timeouts?: {
    caseMs?: number | undefined;
    runMs?: number | undefined;
  };
}

export interface EngineValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface EngineRunConfigValidationSuccess {
  ok: true;
  normalized: {
    modelIdentifier: string;
    serverArgs: string[];
    requestParams: Record<string, unknown>;
  };
  warnings?: string[];
}

export interface EngineRunConfigValidationFailure {
  ok: false;
  code: string;
  message: string;
  issues?: EngineValidationIssue[];
}

export type EngineRunConfigValidationResult =
  | EngineRunConfigValidationSuccess
  | EngineRunConfigValidationFailure;

export interface EngineLaunchConfig {
  command: string;
  args: string[];
  environmentOverrides?: Record<string, string>;
}

export function hasRestrictedEnvironmentOverrides(
  environmentOverrides: Record<string, string>,
): boolean {
  for (const key of Object.keys(environmentOverrides)) {
    if (RESTRICTED_ENVIRONMENT_OVERRIDE_KEYS.has(key.toUpperCase())) {
      return true;
    }
  }

  return false;
}

export interface EngineDiagnostic {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
}

export interface EngineRuntimeContext {
  runId: string;
  abortSignal: AbortSignal;
  launchConfig: EngineLaunchConfig;
  emitDiagnostic?: (diagnostic: EngineDiagnostic) => void;
}

export interface EngineCaseConfig {
  caseId: string;
  index: number;
  promptId: string;
  prompt: string;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  requestParams: Record<string, unknown>;
}

export interface EngineCaseResult {
  outputText: string;
  rawResponse?: unknown;
}

export interface EnginePlugin {
  readonly apiVersion: typeof ENGINE_PLUGIN_API_VERSION;
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly capabilities: EngineCapabilities;

  validateEnvironment(): Promise<EngineEnvironmentSummary>;
  validateRunConfig(
    runConfig: EngineRunConfig,
  ): Promise<EngineRunConfigValidationResult>;
  buildLaunchConfig(runConfig: EngineRunConfig): Promise<EngineLaunchConfig>;
  start(context: EngineRuntimeContext): Promise<void>;
  waitUntilReady(context: EngineRuntimeContext): Promise<void>;
  // Implementations should honor context.abortSignal and stop in-flight work
  // promptly so orchestration timeouts and cancellations reclaim resources.
  executeCase(
    context: EngineRuntimeContext,
    caseConfig: EngineCaseConfig,
  ): Promise<EngineCaseResult>;
  collectMetrics(context: EngineRuntimeContext): Promise<Record<string, unknown>>;
  // Implementations should resolve promptly and force-stop lingering
  // subprocesses after a short grace period.
  stop(context: EngineRuntimeContext): Promise<void>;
}
