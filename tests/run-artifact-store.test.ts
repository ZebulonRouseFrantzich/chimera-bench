import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RunArtifactReadError,
  RunArtifactStore,
  RunArtifactWriteError,
} from "../src/server/runs/run-artifact-store.ts";

describe("RunArtifactStore", () => {
  test("writes and reads run result artifacts", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "chimera-artifact-store-"));

    try {
      const store = new RunArtifactStore(rootDir);
      await store.writeResult("run_11111111-1111-4111-8111-111111111111", {
        runId: "run_11111111-1111-4111-8111-111111111111",
        status: "completed",
      });

      const result = await store.readResult("run_11111111-1111-4111-8111-111111111111");
      expect(result?.runId).toBe("run_11111111-1111-4111-8111-111111111111");
      expect(result?.status).toBe("completed");
    } finally {
      rmSync(rootDir, {
        recursive: true,
        force: true,
      });
    }
  });

  test("rejects run IDs that escape artifact root", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "chimera-artifact-store-"));

    try {
      const store = new RunArtifactStore(rootDir);

      await expect(store.writeResult("../escape", {})).rejects.toBeInstanceOf(
        RunArtifactWriteError,
      );

      await expect(store.readResult("../escape")).rejects.toBeInstanceOf(
        RunArtifactReadError,
      );
    } finally {
      rmSync(rootDir, {
        recursive: true,
        force: true,
      });
    }
  });

  test("bounds tracked write failures to prevent unbounded growth", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "chimera-artifact-store-"));
    const blockedRoot = join(tempDir, "blocked");
    writeFileSync(blockedRoot, "blocked");

    try {
      const store = new RunArtifactStore(blockedRoot);

      for (let index = 0; index < 1005; index += 1) {
        const runId = `run_00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
        await expect(store.writeResult(runId, {})).rejects.toBeInstanceOf(
          RunArtifactWriteError,
        );
      }

      const oldestRunId = "run_00000000-0000-4000-8000-000000000000";
      const newestRunId = "run_00000000-0000-4000-8000-0000000003ec";
      expect(store.getWriteFailure(oldestRunId)).toBeUndefined();
      expect(store.getWriteFailure(newestRunId)).toBeDefined();
    } finally {
      rmSync(tempDir, {
        recursive: true,
        force: true,
      });
    }
  });
});
