import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app.ts";
import type { EngineCatalog } from "../../src/server/engines/engine-catalog.ts";
import type { ServerLogger } from "../../src/server/logging.ts";
import type { EngineEnvironmentValidationSettings } from "../../src/server/routes/engine-routes.ts";
import { RuntimeControl } from "../../src/server/runtime-control.ts";
import type { BasicAuthSettings } from "../../src/server/types.ts";

interface BuildAppInput {
  auth: BasicAuthSettings;
  corsAllowlist?: string[];
  devMode?: boolean;
  logger?: ServerLogger;
  modelRoots?: string[];
  engines?: EngineCatalog;
  engineEnvironmentValidation?: EngineEnvironmentValidationSettings;
  runArtifactsRootDir?: string;
  targetProfilesRootDir?: string;
}

export const TEST_MODEL_IDENTIFIER = "/tmp/model.gguf";
const TEST_RUN_ARTIFACTS_ROOT_DIR = join(
  tmpdir(),
  `chimera-bench-test-runs-${process.pid}`,
);

process.once("exit", () => {
  rmSync(TEST_RUN_ARTIFACTS_ROOT_DIR, {
    recursive: true,
    force: true,
  });
});

export function buildApp(input: BuildAppInput): {
  runtime: RuntimeControl;
  app: ReturnType<typeof createApp>;
} {
  ensureTestModelFixture();
  const runtime = new RuntimeControl();

  return {
    runtime,
    app: createApp({
      version: "0.0.1",
      auth: input.auth,
      corsAllowlist: input.corsAllowlist ?? [],
      runtime,
      runArtifactsRootDir: input.runArtifactsRootDir ?? TEST_RUN_ARTIFACTS_ROOT_DIR,
      ...(typeof input.devMode === "boolean"
        ? {
            devMode: input.devMode,
          }
        : {}),
      ...(input.logger
        ? {
            logger: input.logger,
          }
        : {}),
      ...(input.modelRoots
        ? {
            modelRoots: input.modelRoots,
          }
        : {}),
      ...(input.engineEnvironmentValidation
        ? {
            engineEnvironmentValidation: input.engineEnvironmentValidation,
          }
        : {}),
      ...(input.engines
        ? {
            engines: input.engines,
          }
        : {}),
      ...(input.targetProfilesRootDir
        ? {
            targetProfilesRootDir: input.targetProfilesRootDir,
          }
        : {}),
    }),
  };
}

export async function createRun(app: ReturnType<typeof createApp>): Promise<string> {
  ensureTestModelFixture();

  const createResponse = await app.request("http://localhost/runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      engineId: "llama-cpp",
      target: {
        type: "local",
      },
      model: {
        identifier: TEST_MODEL_IDENTIFIER,
      },
    }),
  });

  if (createResponse.status !== 202) {
    throw new Error(`Expected run creation status 202, received ${createResponse.status}.`);
  }

  const payload = (await createResponse.json()) as {
    data?: {
      runId?: unknown;
    };
  };

  const runId = payload.data?.runId;
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("Run creation response did not include a valid runId.");
  }

  return runId;
}

export function createBasicAuthorization(
  username = "chimera",
  password = "Sup3rSecurePassphrase!",
): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function ensureTestModelFixture(): void {
  if (existsSync(TEST_MODEL_IDENTIFIER)) {
    return;
  }

  writeFileSync(TEST_MODEL_IDENTIFIER, "fixture");
}
