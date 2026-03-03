import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngineCatalog } from "../../src/server/engines/engine-catalog.ts";
import {
  buildApp,
  createTestPlugin,
  TEST_MODEL_IDENTIFIER,
} from "./helpers.ts";

describe("run routes", () => {
  test("rejects invalid run creation payloads", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        target: {
          type: "local",
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.success).toBe(false);
    expect(payload.error.code).toBe("VALIDATION_BODY_INVALID");
  });

  test("rejects unsupported engines", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        engineId: "vllm",
        target: {
          type: "local",
        },
        model: {
          identifier: "/tmp/model.gguf",
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("ENGINE_NOT_SUPPORTED");
  });

  test("accepts run creation for the tuning workload", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
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
        workloadId: "tuning.v0_0_1",
      }),
    });

    expect(response.status).toBe(202);
    const payload = await response.json();
    expect(typeof payload.data?.runId).toBe("string");
  });

  test("rejects unknown workload IDs", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
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
        workloadId: "missing.workload",
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_WORKLOAD_INVALID");
  });

  test("rejects local targets for engines without local capability", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([
        createTestPlugin({
          capabilities: {
            chatCompletions: true,
            localTarget: false,
            sshTarget: true,
            streaming: true,
          },
        }),
      ]),
    });

    const response = await app.request("http://localhost/runs", {
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

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("ENGINE_TARGET_NOT_SUPPORTED");
  });

  test("rejects local targets with unexpected profileId fields", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        engineId: "llama-cpp",
        target: {
          type: "local",
          profileId: "lab",
        },
        model: {
          identifier: TEST_MODEL_IDENTIFIER,
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_BODY_INVALID");
  });

  test("rejects ssh targets for engines without ssh capability", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      engines: createEngineCatalog([createTestPlugin()]),
    });

    const response = await app.request("http://localhost/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        engineId: "llama-cpp",
        target: {
          type: "ssh",
          profileId: "lab",
        },
        model: {
          identifier: "/models/model.gguf",
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("ENGINE_TARGET_NOT_SUPPORTED");
  });

  test("rejects missing model paths with model validation errors", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
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
          identifier: "/tmp/missing-model.gguf",
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_MODEL_IDENTIFIER_INVALID");
    expect(payload.error.details.issues[0].code).toBe("MODEL_IDENTIFIER_NOT_FOUND");
    expect(payload.error.details.issues[0].message).not.toContain("/tmp/missing-model.gguf");
  });

  test("reports invalid model root configuration distinctly", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-runs-misconfig-"));
    const missingRoot = join(tempDirectory, "missing-root");

    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      modelRoots: [missingRoot],
    });

    const response = await app.request("http://localhost/runs", {
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

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_MODEL_ROOTS_INVALID");
    expect(payload.error.details.issues[0].code).toBe("MODEL_ROOT_NOT_FOUND");
    expect(payload.error.details.issues[0].message).not.toContain(missingRoot);

    rmSync(tempDirectory, {
      recursive: true,
      force: true,
    });
  });

  test("enforces CHIMERA_MODEL_ROOTS confinement", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-runs-root-"));
    const rootDirectory = join(tempDirectory, "roots");
    const outsideModel = join(tempDirectory, "outside.gguf");
    mkdirSync(rootDirectory);
    writeFileSync(outsideModel, "fixture");

    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
      modelRoots: [rootDirectory],
    });

    const response = await app.request("http://localhost/runs", {
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
          identifier: outsideModel,
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_MODEL_IDENTIFIER_INVALID");
    expect(payload.error.details.issues[0].code).toBe(
      "MODEL_IDENTIFIER_OUTSIDE_ALLOWED_ROOTS",
    );

    rmSync(tempDirectory, {
      recursive: true,
      force: true,
    });
  });

  test("sanitizes reflected engine identifiers in error messages", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        engineId: "vllm\ncontrol",
        target: {
          type: "local",
        },
        model: {
          identifier: "/tmp/model.gguf",
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("ENGINE_NOT_SUPPORTED");
    expect(payload.error.message).not.toContain("\n");
  });

  test("rejects non-JSON run creation requests", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
      },
      body: "engineId=llama-cpp",
    });

    expect(response.status).toBe(415);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_CONTENT_TYPE_INVALID");
  });

  test("rejects oversized run creation body", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
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
        engine: {
          requestParams: {
            oversized: "x".repeat(70_000),
          },
        },
      }),
    });

    expect(response.status).toBe(413);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_BODY_TOO_LARGE");
  });

  test("formats validation paths with array indexes", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
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
        engine: {
          requestParams: {
            nested: ["x".repeat(9000)],
          },
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_BODY_INVALID");
    expect(payload.error.details.issues[0].path).toContain("nested[0]");
  });

  test("rejects timeout values outside allowed bounds", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
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
        timeouts: {
          runMs: 86_400_001,
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_BODY_INVALID");
    expect(payload.error.details.issues[0].path).toBe("timeouts.runMs");
  });

  test("rejects timeout payloads where case timeout exceeds run timeout", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
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
        timeouts: {
          caseMs: 2_000,
          runMs: 1_000,
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_BODY_INVALID");
    expect(payload.error.details.issues[0].path).toBe("timeouts.caseMs");
  });
});
