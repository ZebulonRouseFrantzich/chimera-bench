import { describe, expect, test } from "bun:test";
import {
  createRunConfig,
  createSshProfile,
  createStarterLlamaCppPlugin,
} from "./helpers.ts";

describe("starter llama.cpp plugin mixed-GPU guard", () => {
  test("requires explicit GPU selection on mixed-GPU SSH targets", async () => {
    const profile = createSshProfile("lab");

    const plugin = createStarterLlamaCppPlugin({
      getTargetProfile: async () => profile,
      discoverRemoteGpuSelectionHints: async () => ({
        gpuDeviceCount: 2,
        mainGpuIndices: [0, 1],
        deviceIdentifiers: ["ROCm0", "ROCm1"],
      }),
    });

    const validationResult = await plugin.validateRunConfig(
      createRunConfig({
        target: {
          type: "ssh",
          profileId: "lab",
        },
        modelIdentifier: "/models/model.gguf",
        validationMode: "permissive",
        serverArgs: ["--threads", "4"],
      }),
    );

    expect(validationResult.ok).toBe(false);
    if (!validationResult.ok) {
      expect(validationResult.code).toBe("VALIDATION_ENGINE_OPTIONS_INVALID");
      const gpuIssue = validationResult.issues?.find((issue) => {
        return issue.code === "SERVER_ARG_GPU_SELECTION_REQUIRED";
      });
      expect(gpuIssue?.message.includes("'--device <identifier>'")).toBe(true);
      expect(gpuIssue?.message.includes("'--main-gpu <index>'")).toBe(true);
      expect(gpuIssue?.message.includes("Detected --main-gpu values: 0, 1.")).toBe(true);
      expect(gpuIssue?.message.includes("Detected --device identifiers: ROCm0, ROCm1.")).toBe(
        true,
      );
    }
  });

  test("accepts explicit GPU selection on mixed-GPU SSH targets", async () => {
    const profile = createSshProfile("lab");

    const plugin = createStarterLlamaCppPlugin({
      getTargetProfile: async () => profile,
      discoverRemoteGpuSelectionHints: async () => ({
        gpuDeviceCount: 2,
        mainGpuIndices: [0, 1],
        deviceIdentifiers: ["ROCm0", "ROCm1"],
      }),
    });

    const validationResult = await plugin.validateRunConfig(
      createRunConfig({
        target: {
          type: "ssh",
          profileId: "lab",
        },
        modelIdentifier: "/models/model.gguf",
        validationMode: "permissive",
        serverArgs: [
          "--threads",
          "4",
          "--main-gpu",
          "0",
        ],
      }),
    );

    expect(validationResult.ok).toBe(true);
  });

  test("requires non-empty --device and --main-gpu values on mixed-GPU targets", async () => {
    const profile = createSshProfile("lab");

    const plugin = createStarterLlamaCppPlugin({
      getTargetProfile: async () => profile,
      discoverRemoteGpuSelectionHints: async () => ({
        gpuDeviceCount: 2,
        mainGpuIndices: [0, 1],
        deviceIdentifiers: ["ROCm0", "ROCm1"],
      }),
    });

    const invalidSelectorForms: readonly string[][] = [
      ["--device"],
      ["--device="],
      ["--main-gpu"],
      ["--main-gpu="],
      ["-mg"],
    ];

    for (const serverArgs of invalidSelectorForms) {
      const validationResult = await plugin.validateRunConfig(
        createRunConfig({
          target: {
            type: "ssh",
            profileId: "lab",
          },
          modelIdentifier: "/models/model.gguf",
          validationMode: "permissive",
          serverArgs,
        }),
      );

      expect(validationResult.ok).toBe(false);
      if (!validationResult.ok) {
        expect(
          validationResult.issues?.some((issue) => {
            return issue.code === "SERVER_ARG_GPU_SELECTION_REQUIRED";
          }),
        ).toBe(true);
      }
    }
  });

  test("accepts split-mode none as explicit mixed-GPU selection", async () => {
    const profile = createSshProfile("lab");

    const plugin = createStarterLlamaCppPlugin({
      getTargetProfile: async () => profile,
      discoverRemoteGpuSelectionHints: async () => ({
        gpuDeviceCount: 2,
        mainGpuIndices: [0, 1],
        deviceIdentifiers: ["ROCm0", "ROCm1"],
      }),
    });

    const withSeparateToken = await plugin.validateRunConfig(
      createRunConfig({
        target: {
          type: "ssh",
          profileId: "lab",
        },
        modelIdentifier: "/models/model.gguf",
        validationMode: "permissive",
        serverArgs: ["--split-mode", "none"],
      }),
    );
    expect(withSeparateToken.ok).toBe(true);

    const withInlineValue = await plugin.validateRunConfig(
      createRunConfig({
        target: {
          type: "ssh",
          profileId: "lab",
        },
        modelIdentifier: "/models/model.gguf",
        validationMode: "permissive",
        serverArgs: ["--split-mode=none"],
      }),
    );
    expect(withInlineValue.ok).toBe(true);

    const withShortFlag = await plugin.validateRunConfig(
      createRunConfig({
        target: {
          type: "ssh",
          profileId: "lab",
        },
        modelIdentifier: "/models/model.gguf",
        validationMode: "permissive",
        serverArgs: ["-sm", "none"],
      }),
    );
    expect(withShortFlag.ok).toBe(true);
  });

  test("does not treat non-none split-mode as sufficient mixed-GPU selection", async () => {
    const profile = createSshProfile("lab");

    const plugin = createStarterLlamaCppPlugin({
      getTargetProfile: async () => profile,
      discoverRemoteGpuSelectionHints: async () => ({
        gpuDeviceCount: 2,
        mainGpuIndices: [0, 1],
        deviceIdentifiers: ["ROCm0", "ROCm1"],
      }),
    });

    const validationResult = await plugin.validateRunConfig(
      createRunConfig({
        target: {
          type: "ssh",
          profileId: "lab",
        },
        modelIdentifier: "/models/model.gguf",
        validationMode: "permissive",
        serverArgs: ["--split-mode", "layer"],
      }),
    );

    expect(validationResult.ok).toBe(false);
    if (!validationResult.ok) {
      expect(
        validationResult.issues?.some((issue) => {
          return issue.code === "SERVER_ARG_GPU_SELECTION_REQUIRED";
        }),
      ).toBe(true);
    }
  });

  test("logs mixed-GPU discovery failures with sanitized values", async () => {
    const profile = createSshProfile("lab\nnode");
    const infoLogs: string[] = [];

    const plugin = createStarterLlamaCppPlugin({
      getTargetProfile: async () => profile,
      discoverRemoteGpuSelectionHints: async () => {
        throw new Error("ssh\tdiscovery\ntimeout\u0007");
      },
      logInfo: (message: string) => {
        infoLogs.push(message);
      },
    });

    const validationResult = await plugin.validateRunConfig(
      createRunConfig({
        target: {
          type: "ssh",
          profileId: "lab",
        },
        modelIdentifier: "/models/model.gguf",
        validationMode: "permissive",
        serverArgs: ["--threads", "4"],
      }),
    );

    expect(validationResult.ok).toBe(true);
    expect(
      infoLogs.some((message) => {
        return message.includes("event=run.validation.gpu_selection_discovery_skipped");
      }),
    ).toBe(true);
    expect(
      infoLogs.some((message) => {
        return message.includes("targetProfileId=lab node");
      }),
    ).toBe(true);
    expect(
      infoLogs.some((message) => {
        return message.includes("reason=ssh discovery timeout");
      }),
    ).toBe(true);
    expect(
      infoLogs.every((message) => {
        return !/[\u0000-\u001f\u007f]/.test(message);
      }),
    ).toBe(true);
  });
});
