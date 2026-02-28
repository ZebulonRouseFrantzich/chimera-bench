import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { basicAuthMiddleware } from "./middleware/basic-auth.ts";
import { corsAllowlistMiddleware } from "./middleware/cors-allowlist.ts";
import {
  getOrCreateRequestId,
  jsonError,
  jsonSuccess,
  setRequestId,
} from "./api/envelope.ts";
import { createOpenApiDocument } from "./api/openapi.ts";
import {
  CreateRunRequestSchema,
  normalizeCreateRunRequest,
  RunIdParamsSchema,
  RunResultDataSchema,
  RunSummaryDataSchema,
  RunStatusSchema,
} from "./api/schemas.ts";
import type { RuntimeControl } from "./runtime-control.ts";
import type { BasicAuthSettings } from "./types.ts";

interface AppOptions {
  version: string;
  auth: BasicAuthSettings;
  corsAllowlist: string[];
  runtime: RuntimeControl;
}

const HEARTBEAT_INTERVAL_MS = 15000;
const SSE_ENCODER = new TextEncoder();
const STARTER_ENGINE_ID = "llama-cpp";
const RUN_CREATE_BODY_LIMIT_BYTES = 64 * 1024;
const MAX_TRACKED_RUNS = 1000;
const TERMINAL_RUN_RETENTION_MS = 6 * 60 * 60 * 1000;

type RunStatus = z.infer<typeof RunStatusSchema>;
type RunSummaryData = z.infer<typeof RunSummaryDataSchema>;
type StoredRunResult = z.infer<typeof RunResultDataSchema>["result"];

interface RunRecord {
  runId: string;
  engineId: string;
  modelIdentifier: string;
  workloadId: string;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface SseRouteOptions {
  runtime: RuntimeControl;
  connectedEvent: string;
  heartbeatEvent: string;
  disconnectedEvent: string;
  payloadBase: Record<string, unknown>;
}

interface ValidationErrorIssue {
  code: string;
  message: string;
  path: string;
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  const openApiDocument = createOpenApiDocument({
    version: options.version,
  });
  const runs = new Map<string, RunRecord>();
  const runResults = new Map<string, StoredRunResult>();

  app.use("*", async (context, next) => {
    const requestId = randomUUID();
    setRequestId(context, requestId);

    await next();

    context.header("X-Request-Id", requestId);
  });

  if (options.corsAllowlist.length > 0) {
    app.use("*", corsAllowlistMiddleware(options.corsAllowlist));
  }

  app.use("*", basicAuthMiddleware(options.auth));

  app.get("/global/health", (context) => {
    return jsonSuccess(context, {
      healthy: true,
      version: options.version,
    });
  });

  app.get("/doc", (context) => {
    // Intentionally return raw OpenAPI JSON rather than the API envelope.
    return context.json(openApiDocument);
  });

  app.get("/event", (context) => {
    return createSseResponse(context, {
      runtime: options.runtime,
      connectedEvent: "server.connected",
      heartbeatEvent: "server.heartbeat",
      disconnectedEvent: "server.disconnected",
      payloadBase: {},
    });
  });

  app.get("/engines", (context) => {
    return jsonSuccess(context, {
      engines: [
        {
          id: STARTER_ENGINE_ID,
          displayName: "llama.cpp",
          version: "unknown",
          capabilities: {
            chatCompletions: true,
            localTarget: true,
            streaming: true,
          },
          environment: {
            status: "unknown",
            message: "Environment validation is not wired yet.",
          },
        },
      ],
    });
  });

  app.post("/runs", async (context) => {
    if (!options.runtime.isAcceptingNewRuns()) {
      return jsonError(context, 409, {
        code: "RUN_SERVER_SHUTTING_DOWN",
        message: "The server is shutting down and cannot accept new runs.",
      });
    }

    if (!ensureRunCapacity(runs, runResults)) {
      return jsonError(context, 409, {
        code: "SERVICE_CAPACITY_REACHED",
        message: `Cannot create run because ${MAX_TRACKED_RUNS} tracked runs are already retained.`,
      });
    }

    const parsedBody = await parseJsonBody(context, CreateRunRequestSchema);
    if (parsedBody instanceof Response) {
      return parsedBody;
    }

    const request = normalizeCreateRunRequest(parsedBody);

    if (request.engineId !== STARTER_ENGINE_ID) {
      return jsonError(context, 400, {
        code: "ENGINE_NOT_SUPPORTED",
        message: `Engine '${request.engineId}' is not available in this build.`,
      });
    }

    const runId = `run_${randomUUID()}`;
    const createdAt = new Date().toISOString();

    runs.set(runId, {
      runId,
      engineId: request.engineId,
      modelIdentifier: request.model.identifier,
      workloadId: request.workloadId,
      status: "queued",
      createdAt,
      startedAt: null,
      finishedAt: null,
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

    const run = runs.get(runId);
    if (!run) {
      return jsonError(context, 404, {
        code: "RUN_NOT_FOUND",
        message: `Run '${runId}' was not found.`,
      });
    }

    return jsonSuccess(context, buildRunSummary(run));
  });

  app.get("/runs/:runId/result", (context) => {
    const runId = parseRunIdParam(context);
    if (runId instanceof Response) {
      return runId;
    }

    const run = runs.get(runId);
    if (!run) {
      return jsonError(context, 404, {
        code: "RUN_NOT_FOUND",
        message: `Run '${runId}' was not found.`,
      });
    }

    const result = runResults.get(runId);
    if (!result) {
      return jsonError(context, 409, {
        code: "RUN_RESULT_NOT_READY",
        message: `Run '${runId}' has not persisted a result yet.`,
      });
    }

    return jsonSuccess(context, {
      runId,
      status: run.status,
      result,
    });
  });

  app.post("/runs/:runId/cancel", async (context) => {
    const runId = parseRunIdParam(context);
    if (runId instanceof Response) {
      return runId;
    }

    const run = runs.get(runId);
    if (!run) {
      return jsonError(context, 404, {
        code: "RUN_NOT_FOUND",
        message: `Run '${runId}' was not found.`,
      });
    }

    if (!isRunCancellable(run.status)) {
      return jsonSuccess(context, {
        runId: run.runId,
        status: run.status,
      });
    }

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

    if (isRunCancellable(run.status)) {
      transitionRunStatus(run, "cancelled", new Date().toISOString());

      if (!runResults.has(run.runId)) {
        runResults.set(run.runId, buildStubResult(run));
      }
    }

    return jsonSuccess(context, {
      runId: run.runId,
      status: run.status,
    });
  });

  app.get("/runs/:runId/event", (context) => {
    const runId = parseRunIdParam(context);
    if (runId instanceof Response) {
      return runId;
    }

    if (!runs.has(runId)) {
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
    });
  });

  app.onError((error, context) => {
    const requestId = getOrCreateRequestId(context);
    console.error(
      `[chimera-bench] requestId=${requestId} method=${context.req.method} path=${context.req.path} error=${error.message}`,
    );

    return jsonError(context, 500, {
      code: "INTERNAL_ERROR",
      message: "An unexpected server error occurred.",
    });
  });

  app.notFound((context) => {
    return jsonError(context, 404, {
      code: "NOT_FOUND",
      message: "Route not found.",
    });
  });

  return app;
}

async function parseJsonBody<T>(
  context: Context,
  schema: z.ZodType<T>,
): Promise<T | Response> {
  const contentType = context.req.header("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return jsonError(context, 415, {
      code: "VALIDATION_CONTENT_TYPE_INVALID",
      message: "Request body content type must be application/json.",
    });
  }

  const payload = await readJsonPayloadWithLimit(context, RUN_CREATE_BODY_LIMIT_BYTES);
  if (payload instanceof Response) {
    return payload;
  }

  const parsed = schema.safeParse(payload);

  if (!parsed.success) {
    return jsonError(context, 400, {
      code: "VALIDATION_BODY_INVALID",
      message: "Request body did not match the expected schema.",
      details: {
        issues: formatValidationIssues(parsed.error.issues),
      },
    });
  }

  return parsed.data;
}

async function readJsonPayloadWithLimit(
  context: Context,
  maxBytes: number,
): Promise<unknown | Response> {
  const body = context.req.raw.body;
  if (!body) {
    return jsonError(context, 400, {
      code: "VALIDATION_JSON_INVALID",
      message: "Request body must be valid JSON.",
    });
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      try {
        await reader.cancel("payload too large");
      } catch {
        // Ignore reader cancellation errors while returning 413.
      }

      return jsonError(context, 413, {
        code: "VALIDATION_BODY_TOO_LARGE",
        message: `Request body exceeds ${maxBytes} bytes.`,
      });
    }

    chunks.push(value);
  }

  if (totalBytes === 0) {
    return jsonError(context, 400, {
      code: "VALIDATION_JSON_INVALID",
      message: "Request body must be valid JSON.",
    });
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const jsonText = new TextDecoder().decode(bytes);

  try {
    return JSON.parse(jsonText) as unknown;
  } catch {
    return jsonError(context, 400, {
      code: "VALIDATION_JSON_INVALID",
      message: "Request body must be valid JSON.",
    });
  }
}

function parseRunIdParam(context: Context): string | Response {
  const parsed = RunIdParamsSchema.safeParse({
    runId: context.req.param("runId"),
  });

  if (!parsed.success) {
    return jsonError(context, 400, {
      code: "VALIDATION_PARAMS_INVALID",
      message: "Run ID path parameter is invalid.",
      details: {
        issues: formatValidationIssues(parsed.error.issues),
      },
    });
  }

  return parsed.data.runId;
}

function buildRunSummary(run: RunRecord): RunSummaryData {
  return {
    runId: run.runId,
    status: run.status,
    engineId: run.engineId,
    workloadId: run.workloadId,
    model: {
      identifier: run.modelIdentifier,
    },
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    summary: {
      totalCases: 0,
      completedCases: 0,
      failedCases: 0,
    },
  };
}

function buildStubResult(run: RunRecord): StoredRunResult {
  return {
    schemaVersion: "0.1.0-preview",
    runId: run.runId,
    status: run.status,
    workloadId: run.workloadId,
    cases: [],
  };
}

function formatValidationIssues(
  issues: readonly z.ZodIssue[],
): ValidationErrorIssue[] {
  return issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: formatIssuePath(issue.path),
  }));
}

function createSseResponse(context: Context, input: SseRouteOptions): Response {
  const requestId = getOrCreateRequestId(context);
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let unregisterSseStream: (() => void) | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const withTimestamp = (
    payload: Record<string, unknown> = {},
  ): Record<string, unknown> => {
    return {
      ...input.payloadBase,
      ...payload,
      timestamp: new Date().toISOString(),
    };
  };

  const enqueueEvent = (event: string, payload: Record<string, unknown>): void => {
    if (!streamController) {
      return;
    }

    try {
      streamController.enqueue(
        SSE_ENCODER.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
      );
    } catch {
      // Stream is already closed or cancelled.
    }
  };

  const pushEvent = (event: string, payload: Record<string, unknown>): void => {
    if (!streamController || closed) {
      return;
    }

    enqueueEvent(event, payload);
  };

  const closeStream = (reason: string): void => {
    if (closed) {
      return;
    }

    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }

    enqueueEvent(
      input.disconnectedEvent,
      withTimestamp({
        reason,
      }),
    );

    closed = true;

    if (streamController) {
      try {
        streamController.close();
      } catch {
        // Stream is already closed or cancelled.
      }
    }

    if (unregisterSseStream) {
      unregisterSseStream();
      unregisterSseStream = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;

      pushEvent(input.connectedEvent, withTimestamp());

      heartbeatInterval = setInterval(() => {
        pushEvent(input.heartbeatEvent, withTimestamp());
      }, HEARTBEAT_INTERVAL_MS);

      unregisterSseStream = input.runtime.registerSseStream({
        close: closeStream,
      });
    },
    cancel() {
      closeStream("client-disconnect");
    },
  });

  context.req.raw.signal.addEventListener(
    "abort",
    () => {
      closeStream("client-disconnect");
    },
    {
      once: true,
    },
  );

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Request-Id": requestId,
    },
  });
}

function ensureRunCapacity(
  runs: Map<string, RunRecord>,
  runResults: Map<string, StoredRunResult>,
): boolean {
  const now = Date.now();
  pruneExpiredTerminalRuns(runs, runResults, now);

  while (runs.size >= MAX_TRACKED_RUNS) {
    const runIdToEvict = findOldestTerminalRunId(runs);
    if (!runIdToEvict) {
      return false;
    }

    runs.delete(runIdToEvict);
    runResults.delete(runIdToEvict);
  }

  return true;
}

function pruneExpiredTerminalRuns(
  runs: Map<string, RunRecord>,
  runResults: Map<string, StoredRunResult>,
  now: number,
): void {
  for (const [runId, run] of runs) {
    if (!isRunTerminal(run.status) || !run.finishedAt) {
      continue;
    }

    const finishedAtMs = Date.parse(run.finishedAt);
    if (!Number.isFinite(finishedAtMs)) {
      continue;
    }

    if (now - finishedAtMs < TERMINAL_RUN_RETENTION_MS) {
      continue;
    }

    runs.delete(runId);
    runResults.delete(runId);
  }
}

function findOldestTerminalRunId(runs: Map<string, RunRecord>): string | null {
  for (const [runId, run] of runs) {
    if (isRunTerminal(run.status)) {
      return runId;
    }
  }

  return null;
}

function isRunTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isRunCancellable(status: RunStatus): boolean {
  return status === "queued" || status === "running";
}

function transitionRunStatus(
  run: RunRecord,
  status: RunStatus,
  atIsoTimestamp: string,
): void {
  if (run.status === status) {
    return;
  }

  if (isRunTerminal(run.status) && !isRunTerminal(status)) {
    return;
  }

  run.status = status;

  if (isRunTerminal(status)) {
    run.finishedAt = atIsoTimestamp;
  }
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return "(root)";
  }

  let formatted = "";

  for (const segment of path) {
    if (typeof segment === "number") {
      formatted += `[${segment}]`;
      continue;
    }

    const normalized =
      typeof segment === "string" ? segment : String(segment.description ?? segment);

    if (!normalized) {
      continue;
    }

    if (formatted.length === 0) {
      formatted = normalized;
    } else {
      formatted += `.${normalized}`;
    }
  }

  return formatted.length > 0 ? formatted : "(root)";
}
