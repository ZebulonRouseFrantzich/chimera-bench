/**
 * Registers `/workloads` API routes for workload discovery and reload.
 *
 * Handlers in this module expose metadata-first payloads by default,
 * optionally include prompt message bodies behind an explicit query flag,
 * and enforce response-size and reload-cooldown safety limits.
 */
import { Buffer } from "node:buffer";
import type { Context, Hono } from "hono";
import {
  getOrCreateRequestId,
  jsonError,
  jsonSuccess,
} from "../api/envelope.ts";
import { toErrorMessage } from "../error-utils.ts";
import {
  WorkloadDetailQuerySchema,
  WorkloadIdParamsSchema,
} from "../api/schemas.ts";
import { sanitizeControlCharacters } from "../http/sanitize.ts";
import { formatValidationIssues } from "../http/validation-issues.ts";
import {
  DEFAULT_SERVER_LOGGER,
  type ServerLogger,
} from "../logging.ts";
import type { StarterWorkload } from "../runs/starter-workload.ts";
import {
  WorkloadReloadCooldownError,
  type WorkloadRegistry,
} from "../workloads/registry.ts";

const INCLUDE_PROMPTS_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

interface RegisterWorkloadRoutesOptions {
  workloads: WorkloadRegistry;
  logger?: ServerLogger;
}

export function registerWorkloadRoutes(
  app: Hono,
  options: RegisterWorkloadRoutesOptions,
): void {
  const logger = options.logger ?? DEFAULT_SERVER_LOGGER;

  app.get("/workloads", async (context) => {
    try {
      const workloads = await options.workloads.listSummaries();
      return jsonSuccess(context, {
        workloads,
      });
    } catch (error) {
      return handleWorkloadRouteError(context, logger, "workloads.list.failed", error);
    }
  });

  app.get("/workloads/:workloadId", async (context) => {
    const workloadId = parseWorkloadIdParam(context);
    if (workloadId instanceof Response) {
      return workloadId;
    }

    const includePrompts = parseIncludePromptsQuery(context);
    if (includePrompts instanceof Response) {
      return includePrompts;
    }

    try {
      const workload = await options.workloads.getWorkload(workloadId);
      if (!workload) {
        return jsonError(context, 404, {
          code: "WORKLOAD_NOT_FOUND",
          message: `Workload '${sanitizeControlCharacters(workloadId)}' was not found.`,
        });
      }

      const payload = buildWorkloadDetailPayload(workload, includePrompts);
      if (!includePrompts) {
        return jsonSuccess(context, payload);
      }

      const requestId = getOrCreateRequestId(context);
      const envelopedPayload = {
        success: true,
        data: payload,
        meta: {
          requestId,
        },
      };
      const serializedPayload = JSON.stringify(envelopedPayload);
      const payloadBytes = Buffer.byteLength(serializedPayload, "utf8");
      if (payloadBytes > INCLUDE_PROMPTS_RESPONSE_MAX_BYTES) {
        return jsonError(context, 413, {
          code: "RESPONSE_TOO_LARGE",
          message:
            "Workload response exceeds the 2 MiB payload limit. Reduce prompt size or omit includePrompts.",
        });
      }

      return new Response(serializedPayload, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-Request-Id": requestId,
        },
      });
    } catch (error) {
      return handleWorkloadRouteError(context, logger, "workloads.get.failed", error);
    }
  });

  app.post("/workloads/reload", async (context) => {
    try {
      const stats = await options.workloads.reload();
      return jsonSuccess(context, stats);
    } catch (error) {
      if (error instanceof WorkloadReloadCooldownError) {
        context.header(
          "Retry-After",
          String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))),
        );
        return jsonError(context, 429, {
          code: "WORKLOADS_RELOAD_COOLDOWN",
          message: "Workload reload is cooling down. Retry after the provided delay.",
          details: {
            retryAfterMs: error.retryAfterMs,
          },
        });
      }

      return handleWorkloadRouteError(context, logger, "workloads.reload.failed", error);
    }
  });
}

function parseWorkloadIdParam(context: Context): string | Response {
  const parsedParams = WorkloadIdParamsSchema.safeParse({
    workloadId: context.req.param("workloadId"),
  });

  if (!parsedParams.success) {
    return jsonError(context, 400, {
      code: "VALIDATION_PARAMS_INVALID",
      message: "Workload ID path parameter is invalid.",
      details: {
        issues: formatValidationIssues(parsedParams.error.issues),
      },
    });
  }

  return parsedParams.data.workloadId;
}

function parseIncludePromptsQuery(context: Context): boolean | Response {
  const parsedQuery = WorkloadDetailQuerySchema.safeParse({
    includePrompts: context.req.query("includePrompts"),
  });

  if (!parsedQuery.success) {
    return jsonError(context, 400, {
      code: "VALIDATION_QUERY_INVALID",
      message: "Workload query parameters are invalid.",
      details: {
        issues: formatValidationIssues(parsedQuery.error.issues),
      },
    });
  }

  return parsedQuery.data.includePrompts === "1";
}

function buildWorkloadDetailPayload(
  workload: StarterWorkload,
  includePrompts: boolean,
): {
  workloadId: string;
  displayName: string;
  version: string;
  promptCount: number;
  source: "built-in" | "filesystem";
  promptIds: string[];
  prompts?: Array<{
    promptId: string;
    caseId: string;
    messages: Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }>;
    contextFiles?: string[];
    notes?: string;
  }>;
} {
  return {
    workloadId: workload.workloadId,
    displayName: workload.displayName,
    version: workload.version,
    promptCount: workload.cases.length,
    source: workload.source,
    promptIds: workload.cases.map((workloadCase) => workloadCase.promptId),
    ...(includePrompts
      ? {
          prompts: workload.cases.map((workloadCase) => {
            return {
              promptId: workloadCase.promptId,
              caseId: workloadCase.caseId,
              messages: workloadCase.messages.map((message) => ({
                role: message.role,
                content: message.content,
              })),
              ...(workloadCase.contextFiles.length > 0
                ? {
                    contextFiles: [...workloadCase.contextFiles],
                  }
                : {}),
              ...(typeof workloadCase.notes === "string"
                ? {
                    notes: workloadCase.notes,
                  }
                : {}),
            };
          }),
        }
      : {}),
  };
}

function handleWorkloadRouteError(
  context: Context,
  logger: ServerLogger,
  event: string,
  error: unknown,
): Response {
  const requestId = getOrCreateRequestId(context);
  logger.error(
    `[chimera-bench] requestId=${requestId}` +
      ` event=${event}` +
      ` reason=${sanitizeControlCharacters(toErrorMessage(error))}`,
  );

  return jsonError(context, 500, {
    code: "WORKLOADS_ROUTE_FAILED",
    message: "Workload request failed due to an unexpected server error.",
  });
}
