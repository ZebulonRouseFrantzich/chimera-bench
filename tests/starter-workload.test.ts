import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  DEFAULT_BUILT_IN_WORKLOAD_ID,
  buildTuningPrompt,
  getBuiltInWorkload,
} from "../src/server/runs/starter-workload.ts";

const TUNING_PROMPT_MAX_BYTES = 128 * 1024;

describe("starter workload registry", () => {
  test("defaults to starter.v2", () => {
    expect(DEFAULT_BUILT_IN_WORKLOAD_ID).toBe("starter.v2");
  });

  test("returns tuning workload with stable identifiers", () => {
    const workload = getBuiltInWorkload("tuning.v1");
    expect(workload).not.toBeNull();
    if (!workload) {
      throw new Error("Expected tuning built-in workload to be registered.");
    }

    expect(workload.workloadId).toBe("tuning.v1");
    expect(workload.cases).toHaveLength(1);
    expect(workload.cases[0]?.caseId).toBe("tuning.v1.case-1");
    expect(workload.cases[0]?.promptId).toBe("tuning.v1.prompt-1");
  });

  test("returns starter.v2 with stable prompt/case IDs", () => {
    const workload = getBuiltInWorkload("starter.v2");
    expect(workload).not.toBeNull();
    if (!workload) {
      throw new Error("Expected starter.v2 built-in workload to be registered.");
    }

    expect(workload.cases).toHaveLength(4);
    expect(workload.cases[0]?.caseId).toBe("starter.v2.case-1");
    expect(workload.cases[0]?.promptId).toBe("starter.v2.prompt-1");
    expect(workload.cases[3]?.caseId).toBe("starter.v2.case-4");
    expect(workload.cases[3]?.promptId).toBe("starter.v2.prompt-4");
    expect(workload.cases[3]?.messages).toHaveLength(3);
  });

  test("drops legacy tuning.v0_0_1 workload ID", () => {
    const legacyWorkload = getBuiltInWorkload("tuning.v0_0_1");
    expect(legacyWorkload).toBeNull();
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
    // v0.1.0 keeps the built-in tuning prompt intentionally compact.
    expect(datasetLines).toHaveLength(32);
    expect(datasetLines[0]?.startsWith("rec-001|")).toBe(true);
    expect(datasetLines[31]?.startsWith("rec-032|")).toBe(true);
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
    // Hash locks the deterministic 32-record tuning prompt contract.
    expect(hash).toBe("5d191c59e33fe4e4a8d813cf1c8ea5d2a3a261de1f528ff19be005b339e07dfc");
  });

  test("starter.v2 prompts match stable regression hashes", () => {
    const workload = getBuiltInWorkload("starter.v2");
    if (!workload) {
      throw new Error("Expected starter.v2 built-in workload to be registered.");
    }

    const hashesByPromptId = Object.fromEntries(
      workload.cases.map((workloadCase) => {
        const hash = createHash("sha256").update(workloadCase.prompt).digest("hex");
        return [workloadCase.promptId, hash];
      }),
    );

    expect(hashesByPromptId).toEqual({
      "starter.v2.prompt-1": "b7ed9a3ef2039ea00fab0cc607c9233795fa026f0666e0ac5bb7f9e308298454",
      "starter.v2.prompt-2": "fca5dc0e3abb422a0debccb6dd4837e654ef764651e0274574790b84f85392b6",
      "starter.v2.prompt-3": "73587f692633bb3099f4de15acd6843eac605769b71fb29d9f51f17dfffabedb",
      "starter.v2.prompt-4": "48a0b20c6b3f76f8bc3aaf9beaca77adae79d7e98e704f014f096c4657682eb9",
    });
  });
});
