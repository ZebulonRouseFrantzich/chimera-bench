/**
 * Readiness polling and startup-failure packaging for starter-engine runs.
 *
 * The probe loop treats transient transport errors as retries while preserving
 * concise diagnostics for deterministic startup failures.
 */
import type { EngineStartFailedError } from "../engine-plugin.ts";
import { EngineStartFailedError as EngineStartFailedErrorClass } from "../engine-plugin.ts";
import { READINESS_ERROR_EXCERPT_CHARS } from "./constants.ts";
import type {
  LlamaServerRunState,
  ProcessTermination,
  ReadinessProbeFailure,
  ReadinessProbeResult,
  StarterLlamaCppPluginDependencies,
} from "./types.ts";
import { normalizeIssueMessage, redactSecret, toError } from "./utils.ts";

export async function waitForReadinessProbe(
  runState: LlamaServerRunState,
  abortSignal: AbortSignal,
  dependencies: StarterLlamaCppPluginDependencies,
): Promise<void> {
  const deadlineMs = dependencies.now() + dependencies.readinessTimeoutMs;
  const terminationGuard = runState.terminationPromise.then<ReadinessProbeFailure>(
    (termination) => ({
      kind: "failed",
      reason: buildReadinessTerminationReason(termination),
    }),
  );

  while (true) {
    if (abortSignal.aborted) {
      throw new Error("Run was aborted while waiting for llama-server readiness.");
    }

    const probeResult = await Promise.race([
      probeReadiness(runState, dependencies),
      terminationGuard,
    ]);
    if (probeResult.kind === "ready") {
      return;
    }

    if (probeResult.kind === "failed") {
      throw new Error(probeResult.reason);
    }

    if (dependencies.now() >= deadlineMs) {
      throw new Error(
        `Timed out waiting ${dependencies.readinessTimeoutMs}ms for llama-server readiness at ${runState.healthUrl}.`,
      );
    }

    await dependencies.wait(dependencies.readinessPollIntervalMs);
  }
}

export function buildEngineStartFailedError(input: {
  runId: string;
  reason: string;
  runState: LlamaServerRunState;
  dependencies: StarterLlamaCppPluginDependencies;
}): EngineStartFailedError {
  const secret = input.runState.apiKey;
  const stderrExcerpt = redactSecret(
    input.runState.stderrBuffer.excerpt(input.dependencies.diagnosticExcerptChars),
    secret,
  );
  const stdoutExcerpt = redactSecret(
    input.runState.stdoutBuffer.excerpt(input.dependencies.diagnosticExcerptChars),
    secret,
  );

  const details: Record<string, unknown> = {
    code: "ENGINE_START_FAILED",
    reason: redactSecret(input.reason, secret),
    ...(stderrExcerpt.length > 0
      ? {
          stderrExcerpt,
        }
      : {}),
    ...(stdoutExcerpt.length > 0
      ? {
          stdoutExcerpt,
        }
      : {}),
  };

  return new EngineStartFailedErrorClass(`ENGINE_START_FAILED: ${details.reason as string}`, details);
}

function buildReadinessTerminationReason(termination: ProcessTermination): string {
  if (termination.kind === "error") {
    return `llama-server process terminated before readiness: ${termination.error.message}`;
  }

  if (termination.code !== null) {
    return `llama-server process terminated before readiness with exit code ${termination.code}.`;
  }

  if (termination.signal !== null) {
    return `llama-server process terminated before readiness with signal ${termination.signal}.`;
  }

  return "llama-server process terminated before readiness.";
}

async function probeReadiness(
  runState: LlamaServerRunState,
  dependencies: StarterLlamaCppPluginDependencies,
): Promise<ReadinessProbeResult> {
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    timeoutController.abort();
  }, dependencies.readinessRequestTimeoutMs);

  try {
    const response = await dependencies.fetch(runState.healthUrl, {
      method: "GET",
      headers: runState.healthRequestHeaders,
      signal: timeoutController.signal,
    });

    if (response.ok) {
      return {
        kind: "ready",
      };
    }

    if (response.status === 503) {
      return {
        kind: "retry",
      };
    }

    const bodyExcerpt = await readResponseExcerpt(response, READINESS_ERROR_EXCERPT_CHARS);
    return {
      kind: "failed",
      reason:
        `llama-server readiness check returned HTTP ${response.status}.` +
        (bodyExcerpt.length > 0 ? ` Response excerpt: ${bodyExcerpt}` : ""),
    };
  } catch (error) {
    const probeError = toError(error);
    if (isTransientReadinessError(probeError)) {
      return {
        kind: "retry",
      };
    }

    return {
      kind: "failed",
      reason: `llama-server readiness probe failed: ${probeError.message}`,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function isTransientReadinessError(error: Error): boolean {
  const errorWithCode = error as NodeJS.ErrnoException;
  if (error.name === "AbortError") {
    return true;
  }

  const code = errorWithCode.code;
  if (
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND" ||
    code === "EHOSTUNREACH"
  ) {
    return true;
  }

  const normalizedMessage = error.message.toLowerCase();
  return (
    normalizedMessage.includes("connection refused") ||
    normalizedMessage.includes("fetch failed") ||
    normalizedMessage.includes("timed out") ||
    normalizedMessage.includes("aborted") ||
    normalizedMessage.includes("socket hang up") ||
    normalizedMessage.includes("socket connection was closed unexpectedly") ||
    normalizedMessage.includes("connection was closed unexpectedly")
  );
}

async function readResponseExcerpt(response: Response, maxChars: number): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let excerpt = "";

  try {
    while (excerpt.length < maxChars) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      excerpt += decoder.decode(chunk.value, {
        stream: true,
      });
    }

    excerpt += decoder.decode();
    return normalizeIssueMessage(excerpt).slice(0, maxChars);
  } catch {
    return "";
  } finally {
    void reader.cancel().catch(() => {
      return;
    });
  }
}
