/**
 * Run orchestration pipeline across engine lifecycle phases.
 *
 * This module translates engine interactions into stable run-store state,
 * applies timeout/cancellation policy, and persists terminal artifacts.
 */
import { toError } from "../../error-utils.ts";
import type { EngineCatalog } from "../../engines/engine-catalog.ts";
import type {
  EngineRunConfig,
  EngineRuntimeContext,
} from "../../engines/engine-plugin.ts";
import { sanitizeControlCharacters } from "../../http/sanitize.ts";
import type { RuntimeControl } from "../../runtime-control.ts";
import { InMemoryRunStore } from "../in-memory-run-store/index.ts";
import { DEFAULT_CASE_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS } from "../defaults.ts";
import { persistRunArtifact } from "../persist-run-artifact.ts";
import type { RunArtifactStore } from "../run-artifact-store.ts";
import {
  buildEngineCaseConfig,
  failRunWithRemainingCases,
  logDiagnostic,
} from "./support.ts";
import {
  CaseExecutionTimeoutError,
  FatalRunExecutionError,
  RunCancelledError,
  RunTimeoutExceededError,
  isAbortError,
  isFatalEngineFailure,
  linkAbortSignal,
  toRunFailure,
  withTimeout,
} from "./runtime.ts";
import type { StarterWorkload } from "../starter-workload.ts";
import type { ExpandedSweepCase } from "../sweep-expansion.ts";
import { executeSweepRunOrFailMissingPlugin } from "./sweep-execution/index.ts";
import { estimateTokenCount } from "../token-estimation.ts";

interface RunOrchestratorOptions {
  runtime: RuntimeControl;
  runStore: InMemoryRunStore;
  runArtifacts: RunArtifactStore;
  engines: EngineCatalog;
  now?: () => number;
}

interface StartRunInput {
  runId: string;
  runConfig: EngineRunConfig;
  workload: StarterWorkload;
  sweepCases?: readonly ExpandedSweepCase[];
}

const ENGINE_STOP_TIMEOUT_MS = 10_000;

export class RunOrchestrator {
  private readonly now: () => number;

  constructor(private readonly options: RunOrchestratorOptions) {
    this.now = options.now ?? Date.now;
  }

  start(input: StartRunInput): void {
    void this.execute(input).catch((error) => {
      const reason = sanitizeControlCharacters(toError(error).message);
      console.error(
        `[chimera-bench] runId=${input.runId} runOrchestrationUnhandledError=${reason}`,
      );
    });
  }

  private async execute(input: StartRunInput): Promise<void> {
    const initialStatus = this.options.runStore.getRunStatus(input.runId);
    if (initialStatus !== "queued") {
      return;
    }

    const plugin = this.options.engines.getById(input.runConfig.engineId);
    if (input.sweepCases) {
      await executeSweepRunOrFailMissingPlugin({
        runId: input.runId,
        runConfig: input.runConfig,
        sweepCases: input.sweepCases,
        runStore: this.options.runStore,
        runArtifacts: this.options.runArtifacts,
        runtime: this.options.runtime,
        plugin,
        now: this.now,
      });
      return;
    }

    if (!plugin) {
      failRunWithRemainingCases({
        runStore: this.options.runStore,
        runId: input.runId,
        workload: input.workload,
        engineArgs: input.runConfig.engine.serverArgs,
        requestParams: input.runConfig.engine.requestParams,
        startIndex: 0,
        failure: {
          code: "ENGINE_NOT_SUPPORTED",
          message: `Engine '${input.runConfig.engineId}' is not available in this build.`,
        },
        nowIso: this.nowIso(),
      });
      return;
    }

    const runTimeoutMs = input.runConfig.timeouts?.runMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const caseTimeoutMs = input.runConfig.timeouts?.caseMs ?? DEFAULT_CASE_TIMEOUT_MS;
    const runDeadlineMs = this.now() + runTimeoutMs;

    const abortController = new AbortController();
    let cancellationRequested = false;
    let cancellationReason = "cancelled";
    let engineContext: EngineRuntimeContext | null = null;
    let engineStopInFlight: Promise<void> | null = null;
    let engineStopCompleted = false;
    let unregisterEngineProcess: (() => void) | null = null;
    let nextCaseIndex = 0;

    const getRemainingRunTimeMs = (): number => {
      return Math.max(1, runDeadlineMs - this.now());
    };

    const stopEngine = async (reason: string): Promise<void> => {
      if (!engineContext || engineStopCompleted) {
        return;
      }

      const activeEngineContext = engineContext;

      // Timeout, cancel, and final cleanup paths can converge here; share one
      // stop promise so plugin.stop() runs at most once per run.
      if (engineStopInFlight) {
        await engineStopInFlight;
        return;
      }

      const stopAttempt = (async (): Promise<void> => {
        await withTimeout(
          Promise.resolve().then(() => plugin.stop(activeEngineContext)),
          ENGINE_STOP_TIMEOUT_MS,
          () => new Error(`Engine stop timed out after ${ENGINE_STOP_TIMEOUT_MS}ms.`),
        );
        engineStopCompleted = true;
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

    const unregisterActiveRunCanceller = this.options.runtime.setActiveRunCanceller(
      async (reason) => {
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
      },
    );

    try {
      const launchConfig = await withTimeout(
        plugin.buildLaunchConfig(input.runConfig),
        getRemainingRunTimeMs(),
        () => new RunTimeoutExceededError(runTimeoutMs),
        () => {
          abortController.abort();
        },
      );
      engineContext = {
        runId: input.runId,
        abortSignal: abortController.signal,
        launchConfig,
        emitDiagnostic: (diagnostic) => {
          logDiagnostic(input.runId, diagnostic);
        },
      };

      await withTimeout(
        plugin.start(engineContext),
        getRemainingRunTimeMs(),
        () => new RunTimeoutExceededError(runTimeoutMs),
        () => {
          abortController.abort();
          void stopEngine("run-timeout").catch((error) => {
            const stopReason = sanitizeControlCharacters(toError(error).message);
            console.error(
              `[chimera-bench] runId=${input.runId} timeoutStopError=${stopReason}`,
            );
          });
        },
      );

      unregisterEngineProcess = this.options.runtime.registerEngineProcess({
        stop: stopEngine,
      });

      await withTimeout(
        plugin.waitUntilReady(engineContext),
        getRemainingRunTimeMs(),
        () => new RunTimeoutExceededError(runTimeoutMs),
        () => {
          abortController.abort();
          void stopEngine("run-timeout").catch((error) => {
            const stopReason = sanitizeControlCharacters(toError(error).message);
            console.error(
              `[chimera-bench] runId=${input.runId} timeoutStopError=${stopReason}`,
            );
          });
        },
      );

      if (cancellationRequested || abortController.signal.aborted) {
        throw new RunCancelledError("Run cancelled before case execution started.");
      }

      this.options.runStore.markRunRunning(input.runId, this.nowIso());

      for (; nextCaseIndex < input.workload.cases.length; nextCaseIndex += 1) {
        const workloadCase = input.workload.cases[nextCaseIndex];
        if (!workloadCase) {
          continue;
        }

        if (cancellationRequested || abortController.signal.aborted) {
          throw new RunCancelledError("Run cancelled during execution.");
        }

        if (this.now() >= runDeadlineMs) {
          throw new RunTimeoutExceededError(runTimeoutMs);
        }

        this.options.runStore.recordCaseStarted(input.runId, {
          caseId: workloadCase.caseId,
          promptId: workloadCase.promptId,
          index: nextCaseIndex,
        });

        const contextTokens = estimateTokenCount(workloadCase.prompt);
        const caseStartMs = this.now();
        const remainingRunMs = getRemainingRunTimeMs();
        // A case timeout cannot outlive the run budget; cap per-case timeout to
        // remaining run time so run-level timeout semantics stay authoritative.
        const effectiveCaseTimeoutMs = Math.max(1, Math.min(caseTimeoutMs, remainingRunMs));
        const caseAbortController = new AbortController();
        const unlinkCaseAbort = linkAbortSignal(abortController.signal, caseAbortController);

        try {
          const caseResult = await withTimeout(
            plugin.executeCase(
              {
                ...engineContext,
                abortSignal: caseAbortController.signal,
              },
              buildEngineCaseConfig(workloadCase, nextCaseIndex, input.runConfig),
            ),
            effectiveCaseTimeoutMs,
            () => {
              if (this.now() >= runDeadlineMs) {
                return new RunTimeoutExceededError(runTimeoutMs);
              }

              return new CaseExecutionTimeoutError(
                workloadCase.caseId,
                effectiveCaseTimeoutMs,
              );
            },
            () => {
              caseAbortController.abort();
            },
          );

          this.options.runStore.recordCaseCompleted(input.runId, {
            caseId: workloadCase.caseId,
            promptId: workloadCase.promptId,
            index: nextCaseIndex,
            contextTokens,
            latencyMs: this.now() - caseStartMs,
            outputText: caseResult.outputText,
            engineArgs: input.runConfig.engine.serverArgs,
            requestParams: input.runConfig.engine.requestParams,
            ...(caseResult.rawResponse === undefined
              ? {}
              : {
                  rawResponse: caseResult.rawResponse,
                }),
          });
        } catch (error) {
          if (
            cancellationRequested ||
            abortController.signal.aborted ||
            isAbortError(error)
          ) {
            throw new RunCancelledError("Run cancelled during case execution.");
          }

          const failure = toRunFailure(error);
          this.options.runStore.recordCaseFailed(input.runId, {
            caseId: workloadCase.caseId,
            promptId: workloadCase.promptId,
            index: nextCaseIndex,
            contextTokens,
            latencyMs: this.now() - caseStartMs,
            engineArgs: input.runConfig.engine.serverArgs,
            requestParams: input.runConfig.engine.requestParams,
            error: failure,
          });

          if (isFatalEngineFailure(error)) {
            // The current case has already been recorded as failed; advance so
            // remaining-case failure synthesis starts at the next workload case.
            nextCaseIndex += 1;
            throw new FatalRunExecutionError(failure);
          }
        } finally {
          unlinkCaseAbort();
        }
      }

      if (cancellationRequested || abortController.signal.aborted) {
        throw new RunCancelledError("Run cancelled after case execution.");
      }

      if (this.now() >= runDeadlineMs) {
        throw new RunTimeoutExceededError(runTimeoutMs);
      }

      let metrics: Record<string, unknown> = {};
      try {
        metrics = await withTimeout(
          plugin.collectMetrics(engineContext),
          getRemainingRunTimeMs(),
          () => new RunTimeoutExceededError(runTimeoutMs),
          () => {
            abortController.abort();
          },
        );
      } catch (error) {
        if (error instanceof RunTimeoutExceededError) {
          throw error;
        }

        logDiagnostic(input.runId, {
          level: "warn",
          message: "Engine metrics collection failed; continuing with empty metrics.",
          data: {
            reason: sanitizeControlCharacters(toError(error).message),
          },
        });
      }

      this.options.runStore.completeRun(input.runId, this.nowIso(), metrics);
      await persistRunArtifact({
        runId: input.runId,
        runStore: this.options.runStore,
        runArtifacts: this.options.runArtifacts,
      });
    } catch (error) {
      if (
        error instanceof RunCancelledError ||
        cancellationRequested ||
        isAbortError(error)
      ) {
        this.options.runStore.cancelRun(
          input.runId,
          this.nowIso(),
          sanitizeControlCharacters(cancellationReason),
        );
        await persistRunArtifact({
          runId: input.runId,
          runStore: this.options.runStore,
          runArtifacts: this.options.runArtifacts,
        });
        return;
      }

      if (error instanceof FatalRunExecutionError) {
        failRunWithRemainingCases({
          runStore: this.options.runStore,
          runId: input.runId,
          workload: input.workload,
          engineArgs: input.runConfig.engine.serverArgs,
          requestParams: input.runConfig.engine.requestParams,
          startIndex: nextCaseIndex,
          failure: error.failure,
          nowIso: this.nowIso(),
        });
        await persistRunArtifact({
          runId: input.runId,
          runStore: this.options.runStore,
          runArtifacts: this.options.runArtifacts,
        });
        return;
      }

      failRunWithRemainingCases({
        runStore: this.options.runStore,
        runId: input.runId,
        workload: input.workload,
        engineArgs: input.runConfig.engine.serverArgs,
        requestParams: input.runConfig.engine.requestParams,
        startIndex: nextCaseIndex,
        failure: toRunFailure(error),
        nowIso: this.nowIso(),
      });
      await persistRunArtifact({
        runId: input.runId,
        runStore: this.options.runStore,
        runArtifacts: this.options.runArtifacts,
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

      if (unregisterEngineProcess) {
        unregisterEngineProcess();
      }
    }
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }
}
