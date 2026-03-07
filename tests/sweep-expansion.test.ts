import { describe, expect, test } from "bun:test";
import {
  buildSweepCaseConfigId,
  SweepCaseCanonicalizationError,
} from "../src/server/runs/sweep-expansion.ts";

describe("sweep expansion", () => {
  test("keeps canonicalization error messages path-free for API shaping", () => {
    try {
      buildSweepCaseConfigId({
        engineId: "llama-cpp",
        modelIdentifier: "/models/sample.gguf",
        workloadId: "tuning.v1",
        promptId: "tuning.v1.prompt-1",
        engineArgs: ["--ctx-size", "8192"],
        requestParams: {
          invalid: () => "not-json",
        },
      });
      throw new Error("Expected canonicalization to fail for non-cloneable request params.");
    } catch (error) {
      expect(error).toBeInstanceOf(SweepCaseCanonicalizationError);
      if (!(error instanceof SweepCaseCanonicalizationError)) {
        throw error;
      }

      expect(error.path).toBe("caseConfig");
      expect(error.message).toBe("Sweep case config could not be cloned safely");
      expect(error.message.includes("path=")).toBe(false);
    }
  });
});
