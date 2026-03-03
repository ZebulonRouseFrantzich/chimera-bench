import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  buildTuningPrompt,
  getBuiltInWorkload,
} from "../src/server/runs/starter-workload.ts";

const TUNING_PROMPT_MAX_BYTES = 128 * 1024;

describe("starter workload registry", () => {
  test("returns tuning workload with stable identifiers", () => {
    const workload = getBuiltInWorkload("tuning.v0_0_1");
    expect(workload).not.toBeNull();
    if (!workload) {
      throw new Error("Expected tuning built-in workload to be registered.");
    }

    expect(workload.workloadId).toBe("tuning.v0_0_1");
    expect(workload.cases).toHaveLength(1);
    expect(workload.cases[0]?.caseId).toBe("tuning.v0_0_1.case-1");
    expect(workload.cases[0]?.promptId).toBe("tuning.v0_0_1.prompt-1");
  });
});

describe("tuning workload prompt", () => {
  test("is deterministic and preserves required shape", () => {
    const promptA = buildTuningPrompt();
    const promptB = buildTuningPrompt();
    expect(promptA).toBe(promptB);
    expect(promptA.includes("PROMPT_TOKEN_ESTIMATE=")).toBe(false);

    const lines = promptA.split("\n");
    const beginDatasetIndex = lines.indexOf("BEGIN_DATASET");
    const endDatasetIndex = lines.indexOf("END_DATASET");

    expect(beginDatasetIndex).toBeGreaterThan(-1);
    expect(endDatasetIndex).toBeGreaterThan(beginDatasetIndex);

    const datasetLines = lines.slice(beginDatasetIndex + 1, endDatasetIndex);
    expect(datasetLines).toHaveLength(256);
    expect(datasetLines[0]?.startsWith("rec-001|")).toBe(true);
    expect(datasetLines[255]?.startsWith("rec-256|")).toBe(true);
  });

  test("stays under the built-in prompt byte limit", () => {
    const prompt = buildTuningPrompt();
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(
      TUNING_PROMPT_MAX_BYTES,
    );
  });

  test("matches the stable prompt regression hash", () => {
    const prompt = buildTuningPrompt();
    const hash = createHash("sha256").update(prompt).digest("hex");
    expect(hash).toBe("6582bcdac5332da92c8cb7873ce6d376a58a61cac07a920cbf23cd502ef02d55");
  });
});
