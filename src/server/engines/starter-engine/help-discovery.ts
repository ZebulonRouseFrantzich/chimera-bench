/**
 * llama-server help-output discovery utilities.
 *
 * This module centralizes bounded `--help` capture plus parsing for supported
 * flags and optional GPU selection hints surfaced to SSH validation flows.
 */
import { spawn } from "node:child_process";
import type {
  ChildProcess,
} from "node:child_process";
import type { RemoteGpuSelectionHints } from "./types.ts";
import { toError } from "./utils.ts";

const GPU_HELP_TRUNCATION_MARKER = "\n...[truncated]...\n";
const KNOWN_GPU_BACKEND_PATTERN = /(rocm|cuda|vulkan|metal|sycl|opencl)/i;

export async function captureCommandOutput(
  command: string,
  args: string[],
  timeoutMs: number,
  maxCharsPerStream: number,
): Promise<{
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      rejectPromise(toError(error));
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      child.off("error", onError);
      child.off("close", onClose);
    };

    const onError = (error: Error) => {
      cleanup();
      rejectPromise(error);
    };

    const onClose = () => {
      cleanup();

      if (timedOut) {
        rejectPromise(
          new Error(`Timed out after ${timeoutMs}ms while running '${command} ${args.join(" ")}'.`),
        );
        return;
      }

      // Some llama-server builds exit non-zero for --help while still emitting
      // complete flag documentation; callers validate parsed flag content.

      resolvePromise({
        stdout,
        stderr,
      });
    };

    child.once("error", onError);
    child.once("close", onClose);

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string | Buffer) => {
        stdout = appendBounded(stdout, chunk.toString(), maxCharsPerStream);
      });
    }

    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string | Buffer) => {
        stderr = appendBounded(stderr, chunk.toString(), maxCharsPerStream);
      });
    }
  });
}

export function parseSupportedServerFlags(helpOutput: string): ReadonlySet<string> {
  const supportedFlags = new Set<string>();
  const flagPattern = /(?:^|\s)(--[a-z0-9][a-z0-9-]*|-[a-z0-9])(?=\s|=|,|\]|$)/gi;

  for (const match of helpOutput.matchAll(flagPattern)) {
    const flag = match[1]?.trim().toLowerCase();
    if (!flag) {
      continue;
    }

    supportedFlags.add(flag);
  }

  return supportedFlags;
}

export function parseGpuSelectionHints(helpOutput: string): RemoteGpuSelectionHints {
  const normalizedHelpOutput = helpOutput.replace(/\r\n?/g, "\n");
  const discoveredDeviceIndices = parseDeviceIndices(normalizedHelpOutput);
  const explicitIndices = [...discoveredDeviceIndices].sort((left, right) => {
    return left - right;
  });
  const genericCount = parseGenericGpuDeviceCount(normalizedHelpOutput);

  const deviceIdentifiers = new Set<string>();
  for (const match of normalizedHelpOutput.matchAll(
    /\b(rocm|cuda|vulkan|metal|sycl|opencl)\s*([0-9]+)\b/gi,
  )) {
    const backendToken = match[1]?.toLowerCase();
    const deviceIndexValue = match[2];
    if (!backendToken || !deviceIndexValue) {
      continue;
    }

    const backendPrefix = mapBackendPrefix(backendToken);
    if (!backendPrefix) {
      continue;
    }

    deviceIdentifiers.add(`${backendPrefix}${deviceIndexValue}`);
  }

  const gpuDeviceCount = Math.max(explicitIndices.length, genericCount, deviceIdentifiers.size);
  const mainGpuIndices =
    explicitIndices.length > 0
      ? explicitIndices
      : Array.from({ length: gpuDeviceCount }, (_value, index) => index);

  if (deviceIdentifiers.size === 0 && mainGpuIndices.length > 0) {
    const backendPrefix = detectBackendPrefix(normalizedHelpOutput);
    if (backendPrefix) {
      for (const index of mainGpuIndices) {
        deviceIdentifiers.add(`${backendPrefix}${index}`);
      }
    }
  }

  return {
    gpuDeviceCount,
    mainGpuIndices,
    deviceIdentifiers: [...deviceIdentifiers],
  };
}

function parseDeviceIndices(helpOutput: string): Set<number> {
  const discoveredDeviceIndices = new Set<number>();
  const explicitDeviceLinePattern =
    /^\s*(?:Device|GPU)\s*(?:#)?\s*(\d+)\s*:\s*/gim;

  for (const match of helpOutput.matchAll(explicitDeviceLinePattern)) {
    const indexValue = match[1];
    if (!indexValue) {
      continue;
    }

    const parsedIndex = Number.parseInt(indexValue, 10);
    if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
      continue;
    }

    discoveredDeviceIndices.add(parsedIndex);
  }

  return discoveredDeviceIndices;
}

function parseGenericGpuDeviceCount(helpOutput: string): number {
  const genericCountMatch =
    helpOutput.match(/(?:found|detected)\s+(\d+)\s+[a-z0-9._-]*\s*devices?/i) ??
    helpOutput.match(/(?:found|detected)\s+(\d+)\s+devices?/i);
  const countValue = genericCountMatch?.[1];
  if (!countValue) {
    return 0;
  }

  const parsedCount = Number.parseInt(countValue, 10);
  if (!Number.isInteger(parsedCount) || parsedCount < 0) {
    return 0;
  }

  return parsedCount;
}

function detectBackendPrefix(helpOutput: string): string | null {
  const backendMatch = helpOutput.match(/(?:found|detected)\s+\d+\s+([a-z0-9._-]+)\s*devices?/i);
  const backendToken = backendMatch?.[1]?.toLowerCase();
  if (backendToken) {
    return mapBackendPrefix(backendToken);
  }

  const backendMention = helpOutput.match(KNOWN_GPU_BACKEND_PATTERN)?.[1]?.toLowerCase();
  if (!backendMention) {
    return null;
  }

  return mapBackendPrefix(backendMention);
}

export function parseGpuDeviceCount(helpOutput: string): number {
  return parseGpuSelectionHints(helpOutput).gpuDeviceCount;
}

function mapBackendPrefix(backendToken: string): string | null {
  switch (backendToken) {
    case "rocm":
      return "ROCm";
    case "cuda":
      return "CUDA";
    case "vulkan":
      return "Vulkan";
    case "metal":
      return "Metal";
    case "sycl":
      return "SYCL";
    case "opencl":
      return "OpenCL";
    default:
      return null;
  }
}

function appendBounded(existing: string, nextChunk: string, maxChars: number): string {
  const combined = `${existing}${nextChunk}`;
  if (combined.length <= maxChars) {
    return combined;
  }

  if (maxChars <= GPU_HELP_TRUNCATION_MARKER.length) {
    return combined.slice(-maxChars);
  }

  const retainedChars = maxChars - GPU_HELP_TRUNCATION_MARKER.length;
  const headChars = Math.ceil(retainedChars / 2);
  const tailChars = retainedChars - headChars;

  // Keep both head and tail so early GPU enumeration and trailing flag docs
  // survive output truncation in unusually large help output variants.
  return (
    combined.slice(0, headChars) +
    GPU_HELP_TRUNCATION_MARKER +
    combined.slice(-tailChars)
  );
}
