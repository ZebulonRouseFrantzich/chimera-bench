import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createRunConfig,
  createStarterLlamaCppPlugin,
  TEST_MODEL_IDENTIFIER,
} from "./helpers.ts";

describe("starter llama.cpp plugin process lifecycle", () => {
  test("validates strict server flags via llama-server --help discovery", async () => {
    const plugin = createStarterLlamaCppPlugin({
      discoverSupportedServerFlags: async () =>
        new Set([
          "--threads",
          "--ctx-size",
        ]),
    });

    const strictKnownResult = await plugin.validateRunConfig(
      createRunConfig({
        serverArgs: ["--threads", "4"],
      }),
    );
    expect(strictKnownResult.ok).toBe(true);
    if (strictKnownResult.ok) {
      expect(strictKnownResult.normalized.modelIdentifier).toBe(resolve(TEST_MODEL_IDENTIFIER));
    }

    const strictUnknownResult = await plugin.validateRunConfig(
      createRunConfig({
        serverArgs: ["--not-a-real-flag"],
      }),
    );
    expect(strictUnknownResult.ok).toBe(false);
    if (!strictUnknownResult.ok) {
      expect(strictUnknownResult.issues?.[0]?.code).toBe("SERVER_ARG_UNKNOWN");
    }

    const permissiveUnknownResult = await plugin.validateRunConfig(
      createRunConfig({
        validationMode: "permissive",
        serverArgs: ["--not-a-real-flag"],
      }),
    );
    expect(permissiveUnknownResult.ok).toBe(true);
  });

  test("fails strict validation when --help parsing fails", async () => {
    const plugin = createStarterLlamaCppPlugin({
      discoverSupportedServerFlags: async () => {
        throw new Error("llama-server not found");
      },
    });

    const validationResult = await plugin.validateRunConfig(
      createRunConfig({
        serverArgs: ["--threads", "4"],
      }),
    );

    expect(validationResult.ok).toBe(false);
    if (!validationResult.ok) {
      expect(validationResult.code).toBe("VALIDATION_ENGINE_OPTIONS_INVALID");
      expect(validationResult.issues?.[0]?.code).toBe("SERVER_ARG_FLAG_DISCOVERY_FAILED");
    }
  });

  test("supports strict/permissive requestParams behavior", async () => {
    const plugin = createStarterLlamaCppPlugin({
      discoverSupportedServerFlags: async () => new Set(["--threads"]),
    });

    const strictTopPResult = await plugin.validateRunConfig(
      createRunConfig({
        requestParams: {
          top_p: 0,
        },
      }),
    );
    expect(strictTopPResult.ok).toBe(true);

    const strictResult = await plugin.validateRunConfig(
      createRunConfig({
        requestParams: {
          made_up: 123,
        },
      }),
    );
    expect(strictResult.ok).toBe(false);
    if (!strictResult.ok) {
      expect(strictResult.issues?.[0]?.code).toBe("REQUEST_PARAM_UNKNOWN");
    }

    const permissiveResult = await plugin.validateRunConfig(
      createRunConfig({
        validationMode: "permissive",
        requestParams: {
          made_up: 123,
        },
      }),
    );
    expect(permissiveResult.ok).toBe(true);
  });

  test("reports model root configuration errors with dedicated code", async () => {
    const plugin = createStarterLlamaCppPlugin({
      discoverSupportedServerFlags: async () => new Set(["--threads"]),
      modelRoots: ["/tmp/chimera-missing-root"],
    });

    const validationResult = await plugin.validateRunConfig(createRunConfig());

    expect(validationResult.ok).toBe(false);
    if (!validationResult.ok) {
      expect(validationResult.code).toBe("VALIDATION_MODEL_ROOTS_INVALID");
      expect(validationResult.issues?.[0]?.code).toBe("MODEL_ROOT_NOT_FOUND");
      expect(validationResult.issues?.[0]?.message).not.toContain("/tmp/chimera-missing-root");
    }
  });

  test("rejects model paths outside CHIMERA_MODEL_ROOTS after symlink resolution", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-model-root-"));
    const rootDirectory = join(tempDirectory, "root");
    const outsideModelPath = join(tempDirectory, "outside.gguf");
    const escapedModelPath = join(rootDirectory, "escaped.gguf");

    mkdirSync(rootDirectory);
    writeFileSync(outsideModelPath, "outside");
    symlinkSync(outsideModelPath, escapedModelPath);

    const plugin = createStarterLlamaCppPlugin({
      discoverSupportedServerFlags: async () => new Set(["--threads"]),
      modelRoots: [rootDirectory],
    });

    const validationResult = await plugin.validateRunConfig(
      createRunConfig({
        modelIdentifier: escapedModelPath,
      }),
    );

    expect(validationResult.ok).toBe(false);
    if (!validationResult.ok) {
      expect(validationResult.code).toBe("VALIDATION_MODEL_IDENTIFIER_INVALID");
      expect(validationResult.issues?.[0]?.code).toBe("MODEL_IDENTIFIER_OUTSIDE_ALLOWED_ROOTS");
    }

    rmSync(tempDirectory, {
      recursive: true,
      force: true,
    });
  });

  test("rejects sibling paths that only share root prefix", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-model-root-prefix-"));
    const rootDirectory = join(tempDirectory, "models");
    const siblingDirectory = join(tempDirectory, "modelsevil");
    const siblingModelPath = join(siblingDirectory, "outside.gguf");

    mkdirSync(rootDirectory);
    mkdirSync(siblingDirectory);
    writeFileSync(siblingModelPath, "outside");

    const plugin = createStarterLlamaCppPlugin({
      discoverSupportedServerFlags: async () => new Set(["--threads"]),
      modelRoots: [rootDirectory],
    });

    const validationResult = await plugin.validateRunConfig(
      createRunConfig({
        modelIdentifier: siblingModelPath,
      }),
    );

    expect(validationResult.ok).toBe(false);
    if (!validationResult.ok) {
      expect(validationResult.issues?.[0]?.code).toBe("MODEL_IDENTIFIER_OUTSIDE_ALLOWED_ROOTS");
    }

    rmSync(tempDirectory, {
      recursive: true,
      force: true,
    });
  });

  test("parses negative numeric server arg values correctly", async () => {
    const plugin = createStarterLlamaCppPlugin({
      discoverSupportedServerFlags: async () => new Set(["--temp"]),
    });

    const validationResult = await plugin.validateRunConfig(
      createRunConfig({
        serverArgs: ["--temp", "-0.5"],
      }),
    );

    expect(validationResult.ok).toBe(true);
  });

  test("caches strict flag discovery across validations", async () => {
    let discoveryCalls = 0;
    const plugin = createStarterLlamaCppPlugin({
      discoverSupportedServerFlags: async () => {
        discoveryCalls += 1;
        return new Set(["--threads"]);
      },
    });

    const firstValidation = await plugin.validateRunConfig(
      createRunConfig({
        serverArgs: ["--threads", "4"],
      }),
    );
    const secondValidation = await plugin.validateRunConfig(
      createRunConfig({
        serverArgs: ["--threads", "8"],
      }),
    );

    expect(firstValidation.ok).toBe(true);
    expect(secondValidation.ok).toBe(true);
    expect(discoveryCalls).toBe(1);
  });
});
