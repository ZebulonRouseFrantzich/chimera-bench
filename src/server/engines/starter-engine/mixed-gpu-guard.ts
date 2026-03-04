import type {
  EngineRunConfig,
  EngineValidationIssue,
} from "../engine-plugin.ts";
import type { TargetProfile } from "../../targets/target-profile.ts";
import type {
  RemoteGpuSelectionHints,
  StarterLlamaCppPluginDependencies,
} from "./types.ts";
import {
  extractFlagToken,
  normalizeIssueMessage,
  toError,
} from "./utils.ts";

const EXPLICIT_GPU_SELECTION_FLAGS = new Set([
  "--device",
  "-dev",
  "--main-gpu",
  "-mg",
]);

const SPLIT_MODE_FLAGS = new Set([
  "--split-mode",
  "-sm",
]);

interface EnforceMixedGpuSafetyInput {
  serverArgs: readonly string[];
  dependencies: StarterLlamaCppPluginDependencies;
  target: EngineRunConfig["target"];
  sshProfile: TargetProfile | null;
  issues: EngineValidationIssue[];
}

export async function enforceMixedGpuSafetyForSshTarget(
  input: EnforceMixedGpuSafetyInput,
): Promise<void> {
  if (input.target.type !== "ssh" || !input.sshProfile) {
    return;
  }

  if (hasExplicitGpuSelection(input.serverArgs)) {
    return;
  }

  let gpuSelectionHints: RemoteGpuSelectionHints;
  try {
    gpuSelectionHints = await input.dependencies.discoverRemoteGpuSelectionHints(
      input.sshProfile,
    );
  } catch (error) {
    const reason = normalizeIssueMessage(toError(error).message);
    input.dependencies.logInfo(
      `[chimera-bench] event=run.validation.gpu_selection_discovery_skipped` +
        ` targetProfileId=${input.sshProfile.id}` +
        ` reason=${reason}`,
    );
    return;
  }

  if (gpuSelectionHints.gpuDeviceCount < 2) {
    return;
  }

  const detectedOptionsMessage = formatDetectedGpuSelectionOptions(gpuSelectionHints);

  input.issues.push({
    code: "SERVER_ARG_GPU_SELECTION_REQUIRED",
    message:
      "Remote target appears to expose multiple GPU devices. Add an explicit GPU selector in engine.serverArgs using '--device <identifier>' or '--main-gpu <index>' (or '--split-mode none')." +
      detectedOptionsMessage,
    path: "engine.serverArgs",
  });
}

function formatDetectedGpuSelectionOptions(hints: RemoteGpuSelectionHints): string {
  const guidance: string[] = [];

  if (hints.mainGpuIndices.length > 0) {
    const values = hints.mainGpuIndices
      .slice(0, 8)
      .map((index) => String(index));
    guidance.push(`Detected --main-gpu values: ${values.join(", ")}.`);
  }

  if (hints.deviceIdentifiers.length > 0) {
    // Identifier tokens are constrained to backend+digits by help parser regex.
    const values = hints.deviceIdentifiers.slice(0, 8);
    guidance.push(`Detected --device identifiers: ${values.join(", ")}.`);
  }

  if (guidance.length === 0) {
    return "";
  }

  return ` ${guidance.join(" ")}`;
}

function hasExplicitGpuSelection(serverArgs: readonly string[]): boolean {
  for (let index = 0; index < serverArgs.length; index += 1) {
    const argument = serverArgs[index];
    if (!argument) {
      continue;
    }

    if (!argument.startsWith("-")) {
      continue;
    }

    const rawFlag = extractFlagToken(argument).toLowerCase();
    if (EXPLICIT_GPU_SELECTION_FLAGS.has(rawFlag)) {
      return true;
    }

    if (SPLIT_MODE_FLAGS.has(rawFlag)) {
      const splitModeValue = extractServerArgValue(serverArgs, index);
      if (splitModeValue?.toLowerCase() === "none") {
        return true;
      }
    }
  }

  return false;
}

function extractServerArgValue(
  serverArgs: readonly string[],
  currentIndex: number,
): string | null {
  const currentArg = serverArgs[currentIndex];
  if (!currentArg) {
    return null;
  }

  const equalsIndex = currentArg.indexOf("=");
  if (equalsIndex !== -1) {
    return currentArg.slice(equalsIndex + 1);
  }

  const nextArgument = serverArgs[currentIndex + 1];
  if (typeof nextArgument !== "string" || nextArgument.length === 0) {
    return null;
  }

  if (nextArgument.startsWith("-")) {
    return null;
  }

  return nextArgument;
}
