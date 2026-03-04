import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import type {
  EngineLaunchConfig,
  EngineRunConfig,
  EngineRuntimeContext,
} from "../../src/server/engines/engine-plugin.ts";
import {
  createStarterLlamaCppPlugin as createStarterLlamaCppPluginImpl,
  type StarterLlamaCppPluginDependencies,
} from "../../src/server/engines/starter-engine/index.ts";
import type { TargetProfile } from "../../src/server/targets/target-profile.ts";

export type { SpawnOptionsWithoutStdio, TargetProfile };

export const TEST_API_KEY = "k".repeat(43);
export const TEST_MODEL_IDENTIFIER = "/tmp/model.gguf";

export function createStarterLlamaCppPlugin(
  overrides: Partial<StarterLlamaCppPluginDependencies> = {},
) {
  return createStarterLlamaCppPluginImpl({
    discoverRemoteGpuSelectionHints: async () => ({
      gpuDeviceCount: 1,
      mainGpuIndices: [0],
      deviceIdentifiers: ["ROCm0"],
    }),
    ...overrides,
  });
}

export class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  unrefCalled = false;

  constructor(public readonly pid: number) {
    super();
  }

  kill(_signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    return true;
  }

  unref(): this {
    this.unrefCalled = true;
    return this;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.stdout.end();
    this.stderr.end();
  }

  asChildProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

export function createRunConfig(
  options: {
    serverArgs?: string[];
    requestParams?: Record<string, unknown>;
    validationMode?: "strict" | "permissive";
    modelIdentifier?: string;
    target?: EngineRunConfig["target"];
  } = {},
): EngineRunConfig {
  return {
    engineId: "llama-cpp",
    target:
      options.target ??
      {
        type: "local",
      },
    model: {
      identifier: options.modelIdentifier ?? TEST_MODEL_IDENTIFIER,
    },
    workloadId: "starter.v1",
    validationMode: options.validationMode ?? "strict",
    engine: {
      serverArgs: options.serverArgs ?? [],
      requestParams: options.requestParams ?? {},
    },
  };
}

export function createSshProfile(profileId: string): TargetProfile {
  return {
    schemaVersion: 1,
    id: profileId,
    displayName: "Lab LLM box",
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

export function createContext(runId: string, launchConfig: EngineLaunchConfig): EngineRuntimeContext {
  return {
    runId,
    abortSignal: new AbortController().signal,
    launchConfig,
  };
}

function ensureTestModelFixture(): void {
  if (existsSync(TEST_MODEL_IDENTIFIER)) {
    return;
  }

  writeFileSync(TEST_MODEL_IDENTIFIER, "fixture");
}

ensureTestModelFixture();
