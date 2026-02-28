import { createApp } from "../../src/server/app.ts";
import { RuntimeControl } from "../../src/server/runtime-control.ts";
import type { BasicAuthSettings } from "../../src/server/types.ts";

interface BuildAppInput {
  auth: BasicAuthSettings;
  corsAllowlist?: string[];
}

export function buildApp(input: BuildAppInput): {
  runtime: RuntimeControl;
  app: ReturnType<typeof createApp>;
} {
  const runtime = new RuntimeControl();

  return {
    runtime,
    app: createApp({
      version: "0.1.0",
      auth: input.auth,
      corsAllowlist: input.corsAllowlist ?? [],
      runtime,
    }),
  };
}

export async function createRun(app: ReturnType<typeof createApp>): Promise<string> {
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
        identifier: "/tmp/model.gguf",
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
  password = "devpass",
): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}
