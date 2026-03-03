/**
 * Registers non-create `/runs` routes.
 *
 * This module handles run status/result reads, cancellation requests, and SSE
 * run event streaming while preserving envelope and error semantics.
 */
import type { Hono } from "hono";
import {
  jsonError,
  jsonSuccess,
} from "../../api/envelope.ts";
import { parseRunIdParam } from "../../http/request-validation.ts";
import {
  DEFAULT_SERVER_LOGGER,
  type ServerLogger,
} from "../../logging.ts";
import type { RuntimeControl } from "../../runtime-control.ts";
import {
  type InMemoryRunStore,
  isRunStatusTerminal,
} from "../../runs/in-memory-run-store/index.ts";
import { persistRunArtifact } from "../../runs/persist-run-artifact.ts";
import {
  RunArtifactReadError,
  type RunArtifactStore,
} from "../../runs/run-artifact-store.ts";
import { createSseResponse } from "../../sse/sse-response.ts";

interface RegisterRunSupplementalRoutesInput {
  app: Hono;
  runtime: RuntimeControl;
  runStore: InMemoryRunStore;
  runArtifacts: RunArtifactStore;
  logger?: ServerLogger;
}

export function registerRunSupplementalRoutes(
  input: RegisterRunSupplementalRoutesInput,
): void {
  const { app, runtime, runStore, runArtifacts } = input;
  const logger = input.logger ?? DEFAULT_SERVER_LOGGER;

  app.get("/runs/:runId", (context) => {
    const runId = parseRunIdParam(context);
    if (runId instanceof Response) {
      return runId;
    }

    const summary = runStore.getRunSummary(runId);
    if (!summary) {
      return jsonError(context, 404, {
        code: "RUN_NOT_FOUND",
        message: `Run '${runId}' was not found.`,
      });
    }

    return jsonSuccess(context, summary);
  });

  app.get("/runs/:runId/result", async (context) => {
    const runId = parseRunIdParam(context);
    if (runId instanceof Response) {
      return runId;
    }

    const status = runStore.getRunStatus(runId);
    if (!status) {
      return jsonError(context, 404, {
        code: "RUN_NOT_FOUND",
        message: `Run '${runId}' was not found.`,
      });
    }

    if (!isRunStatusTerminal(status)) {
      return jsonError(context, 409, {
        code: "RUN_RESULT_NOT_READY",
        message: `Run '${runId}' has not persisted a result yet.`,
      });
    }

    const persistenceFailure = runArtifacts.getWriteFailure(runId);
    if (persistenceFailure) {
      return jsonError(context, 500, {
        code: "RUN_RESULT_PERSIST_FAILED",
        message: `Run '${runId}' result artifact could not be persisted.`,
        details: {
          reason: persistenceFailure,
        },
      });
    }

    let result: Record<string, unknown> | null;
    try {
      result = await runArtifacts.readResult(runId);
    } catch (error) {
      const reason =
        error instanceof RunArtifactReadError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Unknown artifact read error.";
      return jsonError(context, 500, {
        code: "RUN_RESULT_READ_FAILED",
        message: `Run '${runId}' result artifact could not be read.`,
        details: {
          reason,
        },
      });
    }

    if (!result) {
      result = runStore.getRunResult(runId) ?? null;
    }

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

    const runStatus = runStore.getRunStatus(runId);
    if (!runStatus) {
      return jsonError(context, 404, {
        code: "RUN_NOT_FOUND",
        message: `Run '${runId}' was not found.`,
      });
    }

    if (!runStore.isRunCancellable(runId)) {
      return jsonSuccess(context, {
        runId,
        status: runStatus,
      });
    }

    if (runStatus === "queued" || runStatus === "running") {
      try {
        await runtime.cancelActiveRun("user-cancel-request");
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
      runStore.cancelRun(
        runId,
        new Date().toISOString(),
        "user-cancel-request",
      ) ?? runStatus;

    if (cancelledStatus === "cancelled") {
      void persistRunArtifact({
        runId,
        runStore,
        runArtifacts,
        logger,
        errorField: "cancelResultPersistError",
      });
    }

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

    if (!runStore.hasRun(runId)) {
      return jsonError(context, 404, {
        code: "RUN_NOT_FOUND",
        message: `Run '${runId}' was not found.`,
      });
    }

    return createSseResponse(context, {
      runtime,
      connectedEvent: "run.connected",
      heartbeatEvent: "run.heartbeat",
      disconnectedEvent: "run.disconnected",
      payloadBase: {
        runId,
      },
      replayEvents: runStore.listRunEvents(runId),
      subscribe: (emit) => {
        return runStore.subscribeRunEvents(runId, (eventRecord) => {
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
