import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngineCatalog } from "../../src/server/engines/engine-catalog.ts";
import {
  buildApp,
  createSshCapableTestPlugin,
  createTargetProfile,
  waitForTerminalRunStatus,
} from "./helpers.ts";

describe("run routes", () => {
  test("rejects ssh targets when the profile id is not found", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-runs-ssh-targets-"));
    const targetsRootDir = join(tempDirectory, "targets");

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        targetProfilesRootDir: targetsRootDir,
        engines: createEngineCatalog([createSshCapableTestPlugin()]),
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
            profileId: "does-not-exist",
          },
          model: {
            identifier: "/models/model.gguf",
          },
        }),
      });

      expect(response.status).toBe(400);
      const payload = await response.json();
      expect(payload.error.code).toBe("VALIDATION_TARGET_PROFILE_NOT_FOUND");
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("rejects ssh model paths outside slash-aware remote model roots", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-runs-ssh-model-"));
    const targetsRootDir = join(tempDirectory, "targets");

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        targetProfilesRootDir: targetsRootDir,
        engines: createEngineCatalog([createSshCapableTestPlugin()]),
      });

      await createTargetProfile(app, {
        id: "lab",
        remoteModelRoots: ["/models"],
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
            identifier: "/models2/other.gguf",
          },
        }),
      });

      expect(response.status).toBe(400);
      const payload = await response.json();
      expect(payload.error.code).toBe("VALIDATION_MODEL_IDENTIFIER_INVALID");
      expect(
        payload.error.details.issues.some((issue: { code?: string }) => {
          return issue.code === "MODEL_IDENTIFIER_OUTSIDE_ALLOWED_ROOTS";
        }),
      ).toBe(true);
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("rejects relative ssh model identifiers", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-runs-ssh-relative-"));
    const targetsRootDir = join(tempDirectory, "targets");

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        targetProfilesRootDir: targetsRootDir,
        engines: createEngineCatalog([createSshCapableTestPlugin()]),
      });

      await createTargetProfile(app, {
        id: "lab",
        remoteModelRoots: ["/models"],
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
            identifier: "models/relative.gguf",
          },
        }),
      });

      expect(response.status).toBe(400);
      const payload = await response.json();
      expect(payload.error.code).toBe("VALIDATION_MODEL_IDENTIFIER_INVALID");
      expect(
        payload.error.details.issues.some((issue: { code?: string }) => {
          return issue.code === "MODEL_IDENTIFIER_NOT_ABSOLUTE";
        }),
      ).toBe(true);
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("rejects ssh model identifiers with control characters", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-runs-ssh-control-char-"));
    const targetsRootDir = join(tempDirectory, "targets");

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        targetProfilesRootDir: targetsRootDir,
        engines: createEngineCatalog([createSshCapableTestPlugin()]),
      });

      await createTargetProfile(app, {
        id: "lab",
        remoteModelRoots: ["/models"],
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
            identifier: "/models/unsafe.gguf\u0000suffix",
          },
        }),
      });

      expect(response.status).toBe(400);
      const payload = await response.json();
      expect(payload.error.code).toBe("VALIDATION_MODEL_IDENTIFIER_INVALID");
      expect(
        payload.error.details.issues.some((issue: { code?: string }) => {
          return issue.code === "MODEL_IDENTIFIER_CONTROL_CHARACTERS";
        }),
      ).toBe(true);
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("rejects ssh model identifiers that traverse outside remote roots", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-runs-ssh-traversal-"));
    const targetsRootDir = join(tempDirectory, "targets");

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        targetProfilesRootDir: targetsRootDir,
        engines: createEngineCatalog([createSshCapableTestPlugin()]),
      });

      await createTargetProfile(app, {
        id: "lab",
        remoteModelRoots: ["/models"],
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
            identifier: "/models/../../etc/passwd.gguf",
          },
        }),
      });

      expect(response.status).toBe(400);
      const payload = await response.json();
      expect(payload.error.code).toBe("VALIDATION_MODEL_IDENTIFIER_INVALID");
      expect(
        payload.error.details.issues.some((issue: { code?: string }) => {
          return issue.code === "MODEL_IDENTIFIER_OUTSIDE_ALLOWED_ROOTS";
        }),
      ).toBe(true);
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("accepts ssh runs with allowlisted model paths and stores targetProfileId", async () => {
    const runArtifactsRootDir = mkdtempSync(join(tmpdir(), "chimera-runs-ssh-artifacts-"));
    const targetsRootDir = mkdtempSync(join(tmpdir(), "chimera-runs-ssh-targets-"));

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        runArtifactsRootDir,
        targetProfilesRootDir: targetsRootDir,
        engines: createEngineCatalog([createSshCapableTestPlugin()]),
      });

      await createTargetProfile(app, {
        id: "lab",
        remoteModelRoots: ["/models"],
      });

      const createResponse = await app.request("http://localhost/runs", {
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
      expect(createResponse.status).toBe(202);

      const createPayload = await createResponse.json();
      const runId = createPayload.data?.runId;
      expect(typeof runId).toBe("string");
      if (typeof runId !== "string") {
        throw new Error("Expected run creation response to include runId.");
      }

      const status = await waitForTerminalRunStatus(app, runId);
      expect(status).toBe("completed");

      const resultResponse = await app.request(`http://localhost/runs/${runId}/result`);
      expect(resultResponse.status).toBe(200);

      const resultPayload = await resultResponse.json();
      expect(resultPayload.data.result.target).toBe("ssh");
      expect(resultPayload.data.result.targetProfileId).toBe("lab");
      expect(resultPayload.data.result.model.identifier).toBe("/models/model.gguf");
    } finally {
      rmSync(runArtifactsRootDir, {
        recursive: true,
        force: true,
      });
      rmSync(targetsRootDir, {
        recursive: true,
        force: true,
      });
    }
  });
});
