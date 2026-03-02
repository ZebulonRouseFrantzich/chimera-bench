import { describe, expect, test } from "bun:test";
import {
  isWithinNormalizedRoot,
  normalizeRemoteModelRoot,
  validateSshModelIdentifier,
} from "../src/server/runs/ssh-model-identifier-validation.ts";

describe("SSH model identifier validation", () => {
  test("accepts allowlisted .gguf paths and normalizes duplicate slashes", () => {
    const result = validateSshModelIdentifier("/models//subdir/model.gguf", ["/models///"]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected model path to be accepted.");
    }

    expect(result.normalizedIdentifier).toBe("/models/subdir/model.gguf");
  });

  test("accepts any absolute .gguf path when root allowlist is '/'", () => {
    const result = validateSshModelIdentifier("/any/path/model.gguf", ["/"]);

    expect(result.ok).toBe(true);
  });

  test("rejects model identifiers outside allowlisted roots", () => {
    const result = validateSshModelIdentifier("/models2/model.gguf", ["/models"]);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected model path to be rejected.");
    }

    expect(result.issues.some((issue) => issue.code === "MODEL_IDENTIFIER_OUTSIDE_ALLOWED_ROOTS")).toBe(
      true,
    );
  });

  test("rejects model identifiers that traverse outside allowlisted roots", () => {
    const result = validateSshModelIdentifier("/models/../../etc/passwd.gguf", ["/models"]);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected model path to be rejected.");
    }

    expect(result.issues.some((issue) => issue.code === "MODEL_IDENTIFIER_OUTSIDE_ALLOWED_ROOTS")).toBe(
      true,
    );
  });

  test("rejects model identifiers containing control characters", () => {
    const identifiers = [
      "/models/model.gguf\u0000suffix",
      "/models/model.gguf\n",
      "/models/model.gguf\t",
    ];

    for (const identifier of identifiers) {
      const result = validateSshModelIdentifier(identifier, ["/models"]);

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("Expected model path to be rejected.");
      }

      expect(
        result.issues.some((issue) => issue.code === "MODEL_IDENTIFIER_CONTROL_CHARACTERS"),
      ).toBe(true);
    }
  });

  test("rejects identifiers when no remote roots are configured", () => {
    const result = validateSshModelIdentifier("/models/model.gguf", []);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected model path to be rejected.");
    }

    expect(result.issues.some((issue) => issue.code === "MODEL_IDENTIFIER_OUTSIDE_ALLOWED_ROOTS")).toBe(
      true,
    );
  });
});

describe("SSH model identifier path helpers", () => {
  test("normalizes remote roots with trailing slashes", () => {
    expect(normalizeRemoteModelRoot("/models///")).toBe("/models");
    expect(normalizeRemoteModelRoot("/")).toBe("/");
  });

  test("applies slash-aware root boundary checks", () => {
    expect(isWithinNormalizedRoot("/models", "/models")).toBe(true);
    expect(isWithinNormalizedRoot("/models/model.gguf", "/models")).toBe(true);
    expect(isWithinNormalizedRoot("/models2/model.gguf", "/models")).toBe(false);
  });
});
