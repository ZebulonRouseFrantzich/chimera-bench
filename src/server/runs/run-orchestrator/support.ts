/**
 * Shared helper routines used by `RunOrchestrator`.
 *
 * This module handles case payload construction, terminal-run fan-out
 * transitions, and diagnostic logging formatting.
 */
import type {
  EngineCaseConfig,
  EngineDiagnostic,
  EngineRunConfig,
} from "../../engines/engine-plugin.ts";
import { sanitizeControlCharacters } from "../../http/sanitize.ts";
import type {
  InMemoryRunStore,
  RunFailureDetails,
} from "../in-memory-run-store/index.ts";
import type { StarterWorkload } from "../starter-workload.ts";
import { estimateTokenCount } from "../token-estimation.ts";

const MAX_DIAGNOSTIC_LINE_CHARS = 4_096;

interface FailRunWithRemainingCasesInput {
  runStore: InMemoryRunStore;
  runId: string;
  workload: StarterWorkload;
  requestParams: Record<string, unknown>;
  startIndex: number;
  failure: RunFailureDetails;
  nowIso: string;
}

export function failRunWithRemainingCases(input: FailRunWithRemainingCasesInput): void {
  // Startup failures happen before the normal running transition. This ensures
  // queued runs still emit a consistent terminal result shape.
  input.runStore.markRunRunning(input.runId, input.nowIso);

  for (let index = input.startIndex; index < input.workload.cases.length; index += 1) {
    const workloadCase = input.workload.cases[index];
    if (!workloadCase) {
      continue;
    }

    input.runStore.recordCaseFailed(input.runId, {
      caseId: workloadCase.caseId,
      promptId: workloadCase.promptId,
      index,
      contextTokens: estimateTokenCount(workloadCase.prompt),
      latencyMs: 0,
      requestParams: input.requestParams,
      error: input.failure,
    });
  }

  input.runStore.failRun(input.runId, input.nowIso, input.failure);
}

export function logDiagnostic(runId: string, diagnostic: EngineDiagnostic): void {
  const message = truncateForLog(
    sanitizeControlCharacters(diagnostic.message),
    MAX_DIAGNOSTIC_LINE_CHARS,
  );
  const data = diagnostic.data
    ? truncateForLog(safeJson(diagnostic.data), MAX_DIAGNOSTIC_LINE_CHARS)
    : "";
  const line =
    `[chimera-bench] runId=${runId} level=${diagnostic.level} message=${message}` +
    (data.length > 0 ? ` data=${data}` : "");

  if (diagnostic.level === "error") {
    console.error(line);
    return;
  }

  if (diagnostic.level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

export function buildEngineCaseConfig(
  workloadCase: StarterWorkload["cases"][number],
  index: number,
  runConfig: EngineRunConfig,
): EngineCaseConfig {
  return {
    caseId: workloadCase.caseId,
    promptId: workloadCase.promptId,
    index,
    prompt: workloadCase.prompt,
    messages: [
      {
        role: "user",
        content: workloadCase.prompt,
      },
    ],
    requestParams: {
      ...runConfig.engine.requestParams,
    },
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function truncateForLog(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}...`;
}
