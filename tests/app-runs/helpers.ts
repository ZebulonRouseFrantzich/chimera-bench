import type { EnginePlugin } from "../../src/server/engines/engine-plugin.ts";
import { ENGINE_PLUGIN_API_VERSION } from "../../src/server/engines/engine-plugin.ts";
import { buildApp, createRun, TEST_MODEL_IDENTIFIER } from "../helpers/app-fixture.ts";

export { buildApp, createRun, TEST_MODEL_IDENTIFIER };

const DEFAULT_WAIT_MAX_ATTEMPTS = 200;
const DEFAULT_WAIT_INTERVAL_MS = 20;

export async function waitForTerminalRunStatus(
  app: ReturnType<typeof buildApp>["app"],
  runId: string,
  options: {
    maxAttempts?: number;
    intervalMs?: number;
  } = {},
): Promise<string> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_WAIT_MAX_ATTEMPTS;
  const intervalMs = options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await app.request(`http://localhost/runs/${runId}`);
    if (response.status !== 200) {
      await Bun.sleep(intervalMs);
      continue;
    }

    const payload = await response.json();
    const status = payload.data?.status;
    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      return status;
    }

    await Bun.sleep(intervalMs);
  }

  throw new Error(`Run '${runId}' did not reach a terminal status in time.`);
}

export async function waitForCondition(
  predicate: () => boolean,
  options: {
    maxAttempts?: number;
    intervalMs?: number;
  } = {},
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_WAIT_MAX_ATTEMPTS;
  const intervalMs = options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (predicate()) {
      return;
    }

    await Bun.sleep(intervalMs);
  }

  throw new Error("Condition did not become true in time.");
}

export async function createTargetProfile(
  app: ReturnType<typeof buildApp>["app"],
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const response = await app.request("http://localhost/targets", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      schemaVersion: 1,
      id: "lab",
      displayName: "Lab",
      host: "10.0.0.10",
      username: "ubuntu",
      remoteModelRoots: ["/models"],
      ...overrides,
    }),
  });

  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`Expected target profile upsert status 200/201, got ${response.status}.`);
  }
}

export function createSshCapableTestPlugin(
  overrides: Partial<EnginePlugin> = {},
): EnginePlugin {
  return createTestPlugin({
    capabilities: {
      chatCompletions: true,
      localTarget: true,
      sshTarget: true,
      streaming: true,
    },
    ...overrides,
  });
}

export function createTestPlugin(overrides: Partial<EnginePlugin> = {}): EnginePlugin {
  return {
    apiVersion: ENGINE_PLUGIN_API_VERSION,
    id: "llama-cpp",
    displayName: "llama.cpp",
    version: "test",
    capabilities: {
      chatCompletions: true,
      localTarget: true,
      sshTarget: false,
      streaming: true,
    },
    validateEnvironment: async () => ({
      status: "ok",
    }),
    validateRunConfig: async (runConfig) => ({
      ok: true,
      normalized: {
        modelIdentifier: runConfig.model.identifier,
        serverArgs: [...runConfig.engine.serverArgs],
        requestParams: { ...runConfig.engine.requestParams },
      },
    }),
    buildLaunchConfig: async (runConfig) => ({
      command: "llama-server",
      args: [...runConfig.engine.serverArgs],
    }),
    start: async () => {
      return;
    },
    waitUntilReady: async () => {
      return;
    },
    executeCase: async () => ({
      outputText: "",
    }),
    collectMetrics: async () => ({}),
    stop: async () => {
      return;
    },
    ...overrides,
  };
}
