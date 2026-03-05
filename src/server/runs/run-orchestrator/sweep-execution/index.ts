/**
 * Sweep run orchestration entrypoint.
 *
 * Handles run-level cancellation/timeout flow and delegates per-case behavior
 * to the sweep case executor.
 */
import { toError } from "../../../error-utils.ts";
import type {
  EnginePlugin,
  EngineRunConfig,
  EngineRuntimeContext,
} from "../../../engines/engine-plugin.ts";
import { sanitizeControlCharacters } from "../../../http/sanitize.ts";
import type { RuntimeControl } from "../../../runtime-control.ts";
import {
  DEFAULT_CASE_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
} from "../../defaults.ts";
import type { InMemoryRunStore } from "../../in-memory-run-store/index.ts";
import { persistRunArtifact } from "../../persist-run-artifact.ts";
import type { RunArtifactStore } from "../../run-artifact-store.ts";
import type { ExpandedSweepCase } from "../../sweep-expansion.ts";
import {
  FatalRunExecutionError,
  RunCancelledError,
  RunTimeoutExceededError,
  isAbortError,
  toRunFailure,
  withTimeout,
} from "../runtime.ts";
import { logDiagnostic } from "../support.ts";
import { executeSweepCase } from "./case-execution.ts";
import { failSweepRunWithRemainingCases } from "./failure-utils.ts";

const ENGINE_STOP_TIMEOUT_MS = 10_000;
const MAX_CONSECUTIVE_ENGINE_LIFECYCLE_FAILURES = 3;

export { failSweepRunWithRemainingCases } from "./failure-utils.ts";

export async function executeSweepRunOrFailMissingPlugin(input: {
  runId: string;
  runConfig: EngineRunConfig;
  sweepCases: readonly ExpandedSweepCase[];
  runStore: InMemoryRunStore;
  runArtifacts: RunArtifactStore;
  runtime: RuntimeControl;
  plugin: EnginePlugin | null | undefined;
  now: () => number;
}): Promise<void> {
  if (!input.plugin) {
    failSweepRunWithRemainingCases({
      runStore: input.runStore,
      runId: input.runId,
      sweepCases: input.sweepCases,
      startIndex: 0,
      failure: {
        code: "ENGINE_NOT_SUPPORTED",
        message: `Engine '${input.runConfig.engineId}' is not available in this build.`,
      },
      nowIso: new Date(input.now()).toISOString(),
    });
    return;
  }

  await executeSweepRun({
    ...input,
    plugin: input.plugin,
  });
}

export async function executeSweepRun(input: {
  runId: string;
  runConfig: EngineRunConfig;
  sweepCases: readonly ExpandedSweepCase[];
  runStore: InMemoryRunStore;
  runArtifacts: RunArtifactStore;
  runtime: RuntimeControl;
  plugin: EnginePlugin;
  now: () => number;
}): Promise<void> {
  const runTimeoutMs = input.runConfig.timeouts?.runMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const caseTimeoutMs = input.runConfig.timeouts?.caseMs ?? DEFAULT_CASE_TIMEOUT_MS;
  const runDeadlineMs = input.now() + runTimeoutMs;

  const abortController = new AbortController();
  let cancellationRequested = false;
  let cancellationReason = "cancelled";
  let engineContext: EngineRuntimeContext | null = null;
  let engineStopInFlight: Promise<void> | null = null;
  let engineStopCompleted = false;
  let unregisterEngineProcess: (() => void) | null = null;
  let nextCaseIndex = 0;
  let consecutiveEngineLifecycleFailures = 0;
  let latestCaseMetrics: Record<string, unknown> = {};

  const nowIso = (): string => {
    return new Date(input.now()).toISOString();
  };

  const getRemainingRunTimeMs = (): number => {
    return Math.max(1, runDeadlineMs - input.now());
  };

  const stopEngine = async (reason: string): Promise<void> => {
    if (!engineContext || engineStopCompleted) {
      return;
    }

    const activeEngineContext = engineContext;
    if (engineStopInFlight) {
      await engineStopInFlight;
      return;
    }

    const stopAttempt = (async (): Promise<void> => {
      await withTimeout(
        Promise.resolve().then(() => input.plugin.stop(activeEngineContext)),
        ENGINE_STOP_TIMEOUT_MS,
        () => new Error(`Engine stop timed out after ${ENGINE_STOP_TIMEOUT_MS}ms.`),
      );
      engineStopCompleted = true;
      if (engineContext === activeEngineContext) {
        engineContext = null;
      }
      logDiagnostic(input.runId, {
        level: "info",
        message: "Engine subprocess stop requested.",
        data: {
          reason,
        },
      });
    })();

    engineStopInFlight = stopAttempt;
    try {
      await stopAttempt;
    } finally {
      if (engineStopInFlight === stopAttempt) {
        engineStopInFlight = null;
      }
    }
  };

  const unregisterActiveRunCanceller = input.runtime.setActiveRunCanceller(async (reason) => {
    cancellationRequested = true;
    cancellationReason = reason;
    abortController.abort();

    try {
      await stopEngine(reason);
    } catch (error) {
      const stopReason = sanitizeControlCharacters(toError(error).message);
      console.error(
        `[chimera-bench] runId=${input.runId} cancellationStopError=${stopReason}`,
      );
    }
  });

  try {
    unregisterEngineProcess = input.runtime.registerEngineProcess({
      stop: stopEngine,
    });

    input.runStore.markRunRunning(input.runId, nowIso());

    for (; nextCaseIndex < input.sweepCases.length; nextCaseIndex += 1) {
      const sweepCase = input.sweepCases[nextCaseIndex];
      if (!sweepCase) {
        continue;
      }

      if (cancellationRequested || abortController.signal.aborted) {
        throw new RunCancelledError("Run cancelled during sweep execution.");
      }

      if (input.now() >= runDeadlineMs) {
        throw new RunTimeoutExceededError(runTimeoutMs);
      }

      input.runStore.recordCaseStarted(input.runId, {
        caseId: sweepCase.caseId,
        promptId: sweepCase.promptId,
        index: nextCaseIndex,
      });

      const caseResult = await executeSweepCase({
        runId: input.runId,
        runConfig: input.runConfig,
        sweepCase,
        caseIndex: nextCaseIndex,
        runStore: input.runStore,
        plugin: input.plugin,
        abortController,
        now: input.now,
        runDeadlineMs,
        runTimeoutMs,
        caseTimeoutMs,
        getRemainingRunTimeMs,
        isCancellationRequested: () => {
          return cancellationRequested;
        },
        stopEngine,
        setEngineContext: (context) => {
          engineContext = context;
          engineStopCompleted = context === null;
        },
      });

      if (caseResult.lifecycleSucceeded) {
        consecutiveEngineLifecycleFailures = 0;
      }

      if (caseResult.status === "completed") {
        latestCaseMetrics = {
          sweepLastCompletedCaseId: sweepCase.caseId,
          sweepLastCompletedCaseMetrics: {
            ...caseResult.metrics,
          },
        };
      }

      if (caseResult.lifecycleFailure && caseResult.failure) {
        consecutiveEngineLifecycleFailures += 1;
        if (consecutiveEngineLifecycleFailures >= MAX_CONSECUTIVE_ENGINE_LIFECYCLE_FAILURES) {
          nextCaseIndex += 1;
          throw new FatalRunExecutionError(caseResult.failure);
        }
      }
    }

    if (cancellationRequested || abortController.signal.aborted) {
      throw new RunCancelledError("Run cancelled after sweep execution.");
    }

    if (input.now() >= runDeadlineMs) {
      throw new RunTimeoutExceededError(runTimeoutMs);
    }

    input.runStore.completeRun(input.runId, nowIso(), latestCaseMetrics);
    await persistRunArtifact({
      runId: input.runId,
      runStore: input.runStore,
      runArtifacts: input.runArtifacts,
    });
  } catch (error) {
    if (error instanceof RunCancelledError || cancellationRequested || isAbortError(error)) {
      input.runStore.cancelRun(
        input.runId,
        nowIso(),
        sanitizeControlCharacters(cancellationReason),
      );
      await persistRunArtifact({
        runId: input.runId,
        runStore: input.runStore,
        runArtifacts: input.runArtifacts,
      });
      return;
    }

    if (error instanceof FatalRunExecutionError) {
      failSweepRunWithRemainingCases({
        runStore: input.runStore,
        runId: input.runId,
        sweepCases: input.sweepCases,
        startIndex: nextCaseIndex,
        failure: error.failure,
        nowIso: nowIso(),
      });
      await persistRunArtifact({
        runId: input.runId,
        runStore: input.runStore,
        runArtifacts: input.runArtifacts,
      });
      return;
    }

    failSweepRunWithRemainingCases({
      runStore: input.runStore,
      runId: input.runId,
      sweepCases: input.sweepCases,
      startIndex: nextCaseIndex,
      failure: toRunFailure(error),
      nowIso: nowIso(),
    });
    await persistRunArtifact({
      runId: input.runId,
      runStore: input.runStore,
      runArtifacts: input.runArtifacts,
    });
  } finally {
    unregisterActiveRunCanceller();

    if (engineContext) {
      try {
        await stopEngine("run-finished");
      } catch (error) {
        const stopReason = sanitizeControlCharacters(toError(error).message);
        console.error(
          `[chimera-bench] runId=${input.runId} finalEngineStopError=${stopReason}`,
        );
      }
    }

    unregisterEngineProcess?.();
  }
}
