import type { Hono } from "hono";
import { jsonError, jsonSuccess } from "../api/envelope.ts";
import {
  CreateRunRequestSchema,
  normalizeCreateRunRequest,
} from "../api/schemas.ts";
import type { EngineCatalog } from "../engines/engine-catalog.ts";
import type {
  EngineRunConfig,
  EngineRunConfigValidationFailure,
  EngineRunConfigValidationResult,
} from "../engines/engine-plugin.ts";
import { parseJsonBody, parseRunIdParam } from "../http/request-validation.ts";
import {
  sanitizeControlCharacters,
  sanitizeErrorCode,
} from "../http/sanitize.ts";
import type { InMemoryRunStore } from "../runs/in-memory-run-store.ts";
import {
  DEFAULT_CASE_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
} from "../runs/defaults.ts";
import { RunOrchestrator } from "../runs/run-orchestrator.ts";
import { getBuiltInWorkload } from "../runs/starter-workload.ts";
import { createSseResponse } from "../sse/sse-response.ts";
import type { RuntimeControl } from "../runtime-control.ts";

const RUN_CREATE_BODY_LIMIT_BYTES = 64 * 1024;

interface RegisterRunRoutesOptions {
  runtime: RuntimeControl;
  runStore: InMemoryRunStore;
  engines: EngineCatalog;
}

export function registerRunRoutes(
  app: Hono,
  options: RegisterRunRoutesOptions,
): void {
  const runOrchestrator = new RunOrchestrator({
    runtime: options.runtime,
    runStore: options.runStore,
    engines: options.engines,
  });

  app.post("/runs", async (context) => {
    if (!options.runtime.isAcceptingNewRuns()) {
      return jsonError(context, 409, {
        code: "RUN_SERVER_SHUTTING_DOWN",
        message: "The server is shutting down and cannot accept new runs.",
      });
    }

    const parsedBody = await parseJsonBody(
      context,
      CreateRunRequestSchema,
      RUN_CREATE_BODY_LIMIT_BYTES,
    );
    if (parsedBody instanceof Response) {
      return parsedBody;
    }

    const request = normalizeCreateRunRequest(parsedBody);

    const plugin = options.engines.getById(request.engineId);
    if (!plugin) {
      const safeEngineId = sanitizeControlCharacters(request.engineId);
      return jsonError(context, 400, {
        code: "ENGINE_NOT_SUPPORTED",
        message: `Engine '${safeEngineId}' is not available in this build.`,
      });
    }

    let validationResult: EngineRunConfigValidationResult;
    try {
      validationResult = await plugin.validateRunConfig(request);
    } catch (error) {
      return jsonError(context, 500, {
        code: "ENGINE_VALIDATION_FAILED",
        message: "Engine validation failed due to an unexpected internal error.",
        ...(error instanceof Error
          ? {
              details: {
                reason: error.message,
              },
            }
          : {}),
      });
    }

    if (!validationResult.ok) {
      return jsonError(context, 400, buildValidationFailurePayload(validationResult));
    }

    request.engine.serverArgs = validationResult.normalized.serverArgs;
    request.engine.requestParams = validationResult.normalized.requestParams;
    request.model.identifier = validationResult.normalized.modelIdentifier;

    const workload = getBuiltInWorkload(request.workloadId);
    if (!workload) {
      return jsonError(context, 400, {
        code: "VALIDATION_WORKLOAD_INVALID",
        message: `Workload '${sanitizeControlCharacters(request.workloadId)}' is not available in this build.`,
      });
    }

    const caseTimeoutMs = request.timeouts.caseMs ?? DEFAULT_CASE_TIMEOUT_MS;
    const runTimeoutMs = request.timeouts.runMs ?? DEFAULT_RUN_TIMEOUT_MS;

    const createRunResult = options.runStore.tryCreateQueuedRunDetailed({
      engineId: request.engineId,
      modelIdentifier: request.model.identifier,
      workloadId: request.workloadId,
      totalCases: workload.cases.length,
      caseTimeoutMs,
      runTimeoutMs,
    });

    if (!createRunResult.ok) {
      if (createRunResult.reason === "concurrency") {
        return jsonError(context, 409, {
          code: "RUN_CONCURRENCY_LIMIT",
          message: "Only one active run is allowed at a time.",
        });
      }

      return jsonError(context, 409, {
        code: "SERVICE_CAPACITY_REACHED",
        message: `Cannot create run because ${options.runStore.getMaxTrackedRuns()} tracked runs are already retained.`,
      });
    }

    const runId = createRunResult.runId;
    const runConfig: EngineRunConfig = {
      engineId: request.engineId,
      target: request.target,
      model: request.model,
      workloadId: request.workloadId,
      validationMode: request.validationMode,
      engine: {
        serverArgs: [...request.engine.serverArgs],
        requestParams: {
          ...request.engine.requestParams,
        },
      },
      timeouts: {
        caseMs: caseTimeoutMs,
        runMs: runTimeoutMs,
      },
    };

    runOrchestrator.start({
      runId,
      runConfig,
      workload,
    });

    return jsonSuccess(
      context,
      {
        runId,
      },
      202,
    );
  });

  app.get("/runs/:runId", (context) => {
    const runId = parseRunIdParam(context);
    if (runId instanceof Response) {
      return runId;
    }

    const summary = options.runStore.getRunSummary(runId);
    if (!summary) {
      return jsonError(context, 404, {
        code: "RUN_NOT_FOUND",
        message: `Run '${runId}' was not found.`,
      });
    }

    return jsonSuccess(context, summary);
  });

  app.get("/runs/:runId/result", (context) => {
    const runId = parseRunIdParam(context);
    if (runId instanceof Response) {
      return runId;
    }

    const status = options.runStore.getRunStatus(runId);
    if (!status) {
      return jsonError(context, 404, {
        code: "RUN_NOT_FOUND",
        message: `Run '${runId}' was not found.`,
      });
    }

    const result = options.runStore.getRunResult(runId);
    if (!result) {
      return jsonError(context, 409, {
        code: "RUN_RESULT_NOT_READY",
        message: `Run '${runId}' has not persisted a result yet.`,
      });
    }

    return jsonSuccess(context, {
      runId,
      status,
      result,
    });
  });

  app.post("/runs/:runId/cancel", async (context) => {
    const runId = parseRunIdParam(context);
    if (runId instanceof Response) {
      return runId;
    }

    const runStatus = options.runStore.getRunStatus(runId);
    if (!runStatus) {
      return jsonError(context, 404, {
        code: "RUN_NOT_FOUND",
        message: `Run '${runId}' was not found.`,
      });
    }

    if (!options.runStore.isRunCancellable(runId)) {
      return jsonSuccess(context, {
        runId,
        status: runStatus,
      });
    }

    if (runStatus === "queued" || runStatus === "running") {
      try {
        await options.runtime.cancelActiveRun("user-cancel-request");
      } catch (error) {
        return jsonError(context, 500, {
          code: "RUN_CANCEL_FAILED",
          message: "Run cancellation failed while stopping active runtime work.",
          ...(error instanceof Error
            ? {
                details: {
                  reason: error.message,
                },
              }
            : {}),
        });
      }
    }

    const cancelledStatus =
      options.runStore.cancelRun(
        runId,
        new Date().toISOString(),
        "user-cancel-request",
      ) ?? runStatus;

    return jsonSuccess(context, {
      runId,
      status: cancelledStatus,
    });
  });

  app.get("/runs/:runId/event", (context) => {
    const runId = parseRunIdParam(context);
    if (runId instanceof Response) {
      return runId;
    }

    if (!options.runStore.hasRun(runId)) {
      return jsonError(context, 404, {
        code: "RUN_NOT_FOUND",
        message: `Run '${runId}' was not found.`,
      });
    }

    return createSseResponse(context, {
      runtime: options.runtime,
      connectedEvent: "run.connected",
      heartbeatEvent: "run.heartbeat",
      disconnectedEvent: "run.disconnected",
      payloadBase: {
        runId,
      },
      replayEvents: options.runStore.listRunEvents(runId),
      subscribe: (emit) => {
        return options.runStore.subscribeRunEvents(runId, (eventRecord) => {
          emit(eventRecord.event, eventRecord.payload);
        });
      },
      shouldCloseAfterEvent: (event) => {
        return (
          event === "run.completed" ||
          event === "run.failed" ||
          event === "run.cancelled"
        );
      },
      closeReason: "run-terminal",
    });
  });
}

function buildValidationFailurePayload(
  failure: EngineRunConfigValidationFailure,
): {
  code: string;
  message: string;
  details?: {
    issues: Array<{
      code: string;
      message: string;
      path: string;
    }>;
  };
} {
  const issues =
    failure.issues
      ?.map((issue) => ({
        code: sanitizeErrorCode(issue.code, "VALIDATION_ENGINE_OPTIONS_INVALID"),
        message: sanitizeControlCharacters(issue.message),
        path: sanitizeIssuePath(issue.path),
      }))
      .filter((issue) => issue.code.length > 0 && issue.message.length > 0) ?? [];

  return {
    code: sanitizeErrorCode(failure.code, "VALIDATION_ENGINE_OPTIONS_INVALID"),
    message: sanitizeControlCharacters(failure.message),
    ...(issues.length > 0
      ? {
          details: {
            issues,
          },
        }
      : {}),
  };
}

function sanitizeIssuePath(path: string | undefined): string {
  const sanitized = sanitizeControlCharacters(path ?? "(root)");
  return sanitized.length > 0 ? sanitized : "(root)";
}
