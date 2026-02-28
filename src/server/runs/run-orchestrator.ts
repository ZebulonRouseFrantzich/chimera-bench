import type { EngineCatalog } from "../engines/engine-catalog.ts";
import type {
  EngineCaseConfig,
  EngineDiagnostic,
  EngineRunConfig,
  EngineRuntimeContext,
} from "../engines/engine-plugin.ts";
import {
  sanitizeControlCharacters,
  sanitizeErrorCode,
} from "../http/sanitize.ts";
import type { RuntimeControl } from "../runtime-control.ts";
import {
  InMemoryRunStore,
  type RunFailureDetails,
} from "./in-memory-run-store.ts";
import {
  DEFAULT_CASE_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
} from "./defaults.ts";
import type { StarterWorkload } from "./starter-workload.ts";

interface RunOrchestratorOptions {
  runtime: RuntimeControl;
  runStore: InMemoryRunStore;
  engines: EngineCatalog;
  now?: () => number;
}

interface StartRunInput {
  runId: string;
  runConfig: EngineRunConfig;
  workload: StarterWorkload;
}

const ENGINE_STOP_TIMEOUT_MS = 10_000;
const MAX_DIAGNOSTIC_LINE_CHARS = 4_096;

class RunCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunCancelledError";
  }
}

class RunTimeoutExceededError extends Error {
  constructor(timeoutMs: number) {
    super(`Run exceeded timeout of ${timeoutMs}ms.`);
    this.name = "RunTimeoutExceededError";
  }
}

class CaseExecutionTimeoutError extends Error {
  constructor(caseId: string, timeoutMs: number) {
    super(`Case '${caseId}' exceeded timeout of ${timeoutMs}ms.`);
    this.name = "CaseExecutionTimeoutError";
  }
}

class FatalRunExecutionError extends Error {
  constructor(readonly failure: RunFailureDetails) {
    super(failure.message);
    this.name = "FatalRunExecutionError";
  }
}

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
    if (!initialStatus || initialStatus !== "queued") {
      return;
    }

    const plugin = this.options.engines.getById(input.runConfig.engineId);
    if (!plugin) {
      this.failRunWithRemainingCases(input, 0, {
        code: "ENGINE_NOT_SUPPORTED",
        message: `Engine '${input.runConfig.engineId}' is not available in this build.`,
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
        this.logDiagnostic(input.runId, {
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
          this.logDiagnostic(input.runId, diagnostic);
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

        const caseStartMs = this.now();
        const remainingRunMs = getRemainingRunTimeMs();
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

              return new CaseExecutionTimeoutError(workloadCase.caseId, effectiveCaseTimeoutMs);
            },
            () => {
              caseAbortController.abort();
            },
          );

          this.options.runStore.recordCaseCompleted(input.runId, {
            caseId: workloadCase.caseId,
            promptId: workloadCase.promptId,
            index: nextCaseIndex,
            latencyMs: this.now() - caseStartMs,
            outputText: caseResult.outputText,
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
            latencyMs: this.now() - caseStartMs,
            requestParams: input.runConfig.engine.requestParams,
            error: failure,
          });

          if (isFatalEngineFailure(error)) {
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

        this.logDiagnostic(input.runId, {
          level: "warn",
          message: "Engine metrics collection failed; continuing with empty metrics.",
          data: {
            reason: sanitizeControlCharacters(toError(error).message),
          },
        });
      }

      this.options.runStore.completeRun(input.runId, this.nowIso(), metrics);
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
        return;
      }

      if (error instanceof FatalRunExecutionError) {
        this.failRunWithRemainingCases(input, nextCaseIndex, error.failure);
        return;
      }

      this.failRunWithRemainingCases(input, nextCaseIndex, toRunFailure(error));
    } finally {
      unregisterActiveRunCanceller();

      let shouldUnregisterEngineProcess = true;

      if (engineContext) {
        try {
          await stopEngine("run-finished");
        } catch (error) {
          shouldUnregisterEngineProcess = false;
          const stopReason = sanitizeControlCharacters(toError(error).message);
          console.error(
            `[chimera-bench] runId=${input.runId} finalEngineStopError=${stopReason}`,
          );
        }
      }

      if (unregisterEngineProcess && shouldUnregisterEngineProcess) {
        unregisterEngineProcess();
      }
    }
  }

  private failRunWithRemainingCases(
    input: StartRunInput,
    startIndex: number,
    failure: RunFailureDetails,
  ): void {
    // Startup failures happen before the normal running transition. This ensures
    // queued runs still emit a consistent terminal result shape.
    this.options.runStore.markRunRunning(input.runId, this.nowIso());

    for (let index = startIndex; index < input.workload.cases.length; index += 1) {
      const workloadCase = input.workload.cases[index];
      if (!workloadCase) {
        continue;
      }

      this.options.runStore.recordCaseFailed(input.runId, {
        caseId: workloadCase.caseId,
        promptId: workloadCase.promptId,
        index,
        latencyMs: 0,
        requestParams: input.runConfig.engine.requestParams,
        error: failure,
      });
    }

    this.options.runStore.failRun(input.runId, this.nowIso(), failure);
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private logDiagnostic(runId: string, diagnostic: EngineDiagnostic): void {
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
}

function buildEngineCaseConfig(
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isFatalEngineFailure(error: unknown): boolean {
  if (!isCodeError(error)) {
    return false;
  }

  return error.code.startsWith("ENGINE_");
}

function toRunFailure(error: unknown): RunFailureDetails {
  if (error instanceof RunTimeoutExceededError) {
    return {
      code: "RUN_TIMEOUT_EXCEEDED",
      message: sanitizeControlCharacters(error.message),
    };
  }

  if (error instanceof CaseExecutionTimeoutError) {
    return {
      code: "RUN_CASE_TIMEOUT",
      message: sanitizeControlCharacters(error.message),
    };
  }

  if (isCodeError(error)) {
    return {
      code: sanitizeErrorCode(error.code, "RUN_CASE_FAILED"),
      message: sanitizeControlCharacters(error.message),
      ...(error.details
        ? {
            details: {
              ...error.details,
            },
          }
        : {}),
    };
  }

  if (error instanceof Error) {
    return {
      code: "RUN_CASE_FAILED",
      message: sanitizeControlCharacters(error.message),
    };
  }

  return {
    code: "RUN_CASE_FAILED",
    message: "Run execution failed with an unknown error.",
  };
}

function isCodeError(
  value: unknown,
): value is {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybeError = value as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };

  return typeof maybeError.code === "string" && typeof maybeError.message === "string";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  return new Error(`Unexpected non-error value: ${String(value)}`);
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  timeoutFactory: () => Error,
  onTimeout?: () => void,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          try {
            onTimeout?.();
          } catch {
            // Best-effort timeout side effects should not mask timeout errors.
          }
          reject(timeoutFactory());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function linkAbortSignal(
  parentSignal: AbortSignal,
  childController: AbortController,
): () => void {
  if (parentSignal.aborted) {
    childController.abort();
    return () => {
      return;
    };
  }

  const onAbort = () => {
    childController.abort();
  };

  parentSignal.addEventListener("abort", onAbort, {
    once: true,
  });

  return () => {
    parentSignal.removeEventListener("abort", onAbort);
  };
}

function truncateForLog(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}...`;
}
