/**
 * Executes one expanded sweep case with full lifecycle handling.
 *
 * This module performs case-level validation, build/start/ready/execute/metrics
 * steps, records per-case outcomes, and guarantees per-case stop attempts.
 */
import { toError } from "../../../error-utils.ts";
import type {
  EnginePlugin,
  EngineRunConfig,
  EngineRuntimeContext,
} from "../../../engines/engine-plugin.ts";
import { sanitizeControlCharacters } from "../../../http/sanitize.ts";
import type {
  InMemoryRunStore,
  RunFailureDetails,
} from "../../in-memory-run-store/index.ts";
import type { ExpandedSweepCase } from "../../sweep-expansion.ts";
import { estimateTokenCount } from "../../token-estimation.ts";
import { logDiagnostic } from "../support.ts";
import {
  CaseExecutionTimeoutError,
  FatalRunExecutionError,
  RunCancelledError,
  RunTimeoutExceededError,
  isAbortError,
  linkAbortSignal,
  toRunFailure,
  withTimeout,
} from "../runtime.ts";
import {
  toSweepCaseValidationFailure,
  toUnexpectedSweepValidationFailure,
} from "./failure-utils.ts";

export interface SweepCaseExecutionResult {
  status: "completed" | "failed";
  failure: RunFailureDetails | null;
  lifecycleFailure: boolean;
  lifecycleSucceeded: boolean;
  metrics: Record<string, unknown>;
}

export async function executeSweepCase(input: {
  runId: string;
  runConfig: EngineRunConfig;
  sweepCase: ExpandedSweepCase;
  caseIndex: number;
  runStore: InMemoryRunStore;
  plugin: EnginePlugin;
  abortController: AbortController;
  now: () => number;
  runDeadlineMs: number;
  runTimeoutMs: number;
  caseTimeoutMs: number;
  getRemainingRunTimeMs: () => number;
  isCancellationRequested: () => boolean;
  stopEngine: (reason: string) => Promise<void>;
  setEngineContext: (context: EngineRuntimeContext | null) => void;
}): Promise<SweepCaseExecutionResult> {
  const contextTokens = estimateTokenCount(input.sweepCase.prompt);
  let caseExecutionStartedMs: number | null = null;
  let caseLatencyMs = 0;
  let caseEngineArgs = [...input.sweepCase.engineArgs];
  let caseRequestParams: Record<string, unknown> = {
    ...input.sweepCase.requestParams,
  };

  const caseRunConfig: EngineRunConfig = {
    engineId: input.runConfig.engineId,
    target: input.runConfig.target,
    model: {
      identifier: input.runConfig.model.identifier,
    },
    workloadId: input.runConfig.workloadId,
    validationMode: input.runConfig.validationMode,
    engine: {
      serverArgs: [...input.sweepCase.engineArgs],
      requestParams: {
        ...input.sweepCase.requestParams,
      },
    },
    ...(input.runConfig.sweep
      ? {
          sweep: input.runConfig.sweep,
        }
      : {}),
    ...(input.runConfig.timeouts
      ? {
          timeouts: {
            ...input.runConfig.timeouts,
          },
        }
      : {}),
  };

  let normalizedCaseConfig: EngineRunConfig;
  try {
    const caseValidation = await withTimeout(
      input.plugin.validateRunConfig(caseRunConfig),
      input.getRemainingRunTimeMs(),
      () => new RunTimeoutExceededError(input.runTimeoutMs),
      () => {
        input.abortController.abort();
      },
    );

    if (!caseValidation.ok) {
      const failure = toSweepCaseValidationFailure(caseValidation);
      input.runStore.recordCaseFailed(input.runId, {
        caseId: input.sweepCase.caseId,
        promptId: input.sweepCase.promptId,
        index: input.caseIndex,
        contextTokens,
        // Validation failed before executeCase() started, so there is no
        // inference latency to record for this case.
        latencyMs: 0,
        engineArgs: caseEngineArgs,
        requestParams: caseRequestParams,
        error: failure,
      });
      return {
        status: "failed",
        failure,
        lifecycleFailure: false,
        lifecycleSucceeded: false,
        metrics: {},
      };
    }

    normalizedCaseConfig = {
      ...caseRunConfig,
      model: {
        identifier: caseValidation.normalized.modelIdentifier,
      },
      engine: {
        serverArgs: [...caseValidation.normalized.serverArgs],
        requestParams: {
          ...caseValidation.normalized.requestParams,
        },
      },
    };

    caseEngineArgs = [...normalizedCaseConfig.engine.serverArgs];
    caseRequestParams = {
      ...normalizedCaseConfig.engine.requestParams,
    };
  } catch (error) {
    if (error instanceof RunTimeoutExceededError) {
      throw error;
    }

    if (input.isCancellationRequested() || input.abortController.signal.aborted || isAbortError(error)) {
      throw new RunCancelledError("Run cancelled during sweep case validation.");
    }

    const failure = toUnexpectedSweepValidationFailure(error);
    input.runStore.recordCaseFailed(input.runId, {
      caseId: input.sweepCase.caseId,
      promptId: input.sweepCase.promptId,
      index: input.caseIndex,
      contextTokens,
      // Unexpected validation failures happen before executeCase(), so latency
      // intentionally remains zero.
      latencyMs: 0,
      engineArgs: caseEngineArgs,
      requestParams: caseRequestParams,
      error: failure,
    });
    return {
      status: "failed",
      failure,
      lifecycleFailure: false,
      lifecycleSucceeded: false,
      metrics: {},
    };
  }

  let lifecycleSucceeded = false;
  let caseAbortController: AbortController | null = null;
  let unlinkCaseAbort: (() => void) | null = null;
  let preservePrimaryFailure = false;

  try {
    const launchConfig = await withTimeout(
      input.plugin.buildLaunchConfig(normalizedCaseConfig),
      input.getRemainingRunTimeMs(),
      () => new RunTimeoutExceededError(input.runTimeoutMs),
      () => {
        input.abortController.abort();
      },
    );

    const caseEngineContext: EngineRuntimeContext = {
      runId: input.runId,
      abortSignal: input.abortController.signal,
      launchConfig,
      emitDiagnostic: (diagnostic) => {
        logDiagnostic(input.runId, diagnostic);
      },
    };
    input.setEngineContext(caseEngineContext);

    await withTimeout(
      input.plugin.start(caseEngineContext),
      input.getRemainingRunTimeMs(),
      () => new RunTimeoutExceededError(input.runTimeoutMs),
      () => {
        input.abortController.abort();
      },
    );

    await withTimeout(
      input.plugin.waitUntilReady(caseEngineContext),
      input.getRemainingRunTimeMs(),
      () => new RunTimeoutExceededError(input.runTimeoutMs),
      () => {
        input.abortController.abort();
      },
    );

    lifecycleSucceeded = true;

    if (input.isCancellationRequested() || input.abortController.signal.aborted) {
      throw new RunCancelledError("Run cancelled during sweep case execution.");
    }

    const remainingRunMs = input.getRemainingRunTimeMs();
    const effectiveCaseTimeoutMs = Math.max(1, Math.min(input.caseTimeoutMs, remainingRunMs));
    caseAbortController = new AbortController();
    unlinkCaseAbort = linkAbortSignal(input.abortController.signal, caseAbortController);

    caseExecutionStartedMs = input.now();
    const caseResult = await withTimeout(
      input.plugin.executeCase(
        {
          ...caseEngineContext,
          abortSignal: caseAbortController.signal,
        },
        {
          caseId: input.sweepCase.caseId,
          promptId: input.sweepCase.promptId,
          index: input.caseIndex,
          prompt: input.sweepCase.prompt,
          messages: [
            {
              role: "user",
              content: input.sweepCase.prompt,
            },
          ],
          requestParams: {
            ...caseRequestParams,
          },
        },
      ),
      effectiveCaseTimeoutMs,
      () => {
        if (input.now() >= input.runDeadlineMs) {
          return new RunTimeoutExceededError(input.runTimeoutMs);
        }

        return new CaseExecutionTimeoutError(input.sweepCase.caseId, effectiveCaseTimeoutMs);
      },
      () => {
        caseAbortController?.abort();
      },
    );
    caseLatencyMs = measureCaseExecutionLatency(caseExecutionStartedMs, input.now);

    let metrics: Record<string, unknown> = {};
    try {
      metrics = await withTimeout(
        input.plugin.collectMetrics(caseEngineContext),
        input.getRemainingRunTimeMs(),
        () => new RunTimeoutExceededError(input.runTimeoutMs),
        () => {
          input.abortController.abort();
        },
      );
    } catch (error) {
      if (error instanceof RunTimeoutExceededError) {
        throw error;
      }

      logDiagnostic(input.runId, {
        level: "warn",
        message: "Engine metrics collection failed for sweep case; continuing.",
        data: {
          reason: sanitizeControlCharacters(toError(error).message),
          caseId: input.sweepCase.caseId,
        },
      });
      metrics = {};
    }

    input.runStore.recordCaseCompleted(input.runId, {
      caseId: input.sweepCase.caseId,
      promptId: input.sweepCase.promptId,
      index: input.caseIndex,
      contextTokens,
      latencyMs: caseLatencyMs,
      outputText: caseResult.outputText,
      engineArgs: caseEngineArgs,
      requestParams: caseRequestParams,
      ...(caseResult.rawResponse === undefined
        ? {}
        : {
            rawResponse: caseResult.rawResponse,
          }),
    });

    return {
      status: "completed",
      failure: null,
      lifecycleFailure: false,
      lifecycleSucceeded: true,
      metrics,
    };
  } catch (error) {
    if (error instanceof RunTimeoutExceededError) {
      preservePrimaryFailure = true;
      throw error;
    }

    if (input.isCancellationRequested() || input.abortController.signal.aborted || isAbortError(error)) {
      preservePrimaryFailure = true;
      throw new RunCancelledError("Run cancelled during sweep case lifecycle.");
    }

    caseLatencyMs = measureCaseExecutionLatency(caseExecutionStartedMs, input.now);

    const failure = toRunFailure(error);
    input.runStore.recordCaseFailed(input.runId, {
      caseId: input.sweepCase.caseId,
      promptId: input.sweepCase.promptId,
      index: input.caseIndex,
      contextTokens,
      latencyMs: caseLatencyMs,
      engineArgs: caseEngineArgs,
      requestParams: caseRequestParams,
      error: failure,
    });

    return {
      status: "failed",
      failure,
      lifecycleFailure: !lifecycleSucceeded,
      lifecycleSucceeded,
      metrics: {},
    };
  } finally {
    unlinkCaseAbort?.();

    try {
      await input.stopEngine("sweep-case-finished");
    } catch (error) {
      if (preservePrimaryFailure) {
        logDiagnostic(input.runId, {
          level: "warn",
          message: "Engine stop failed while preserving primary case failure.",
          data: {
            reason: sanitizeControlCharacters(toError(error).message),
            caseId: input.sweepCase.caseId,
          },
        });
      } else {
        throw new FatalRunExecutionError(toRunFailure(error));
      }
    }
  }
}

function measureCaseExecutionLatency(
  caseExecutionStartedMs: number | null,
  now: () => number,
): number {
  if (caseExecutionStartedMs === null) {
    return 0;
  }

  return Math.max(0, now() - caseExecutionStartedMs);
}
