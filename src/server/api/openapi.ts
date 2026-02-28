import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  CancelRunEnvelopeSchema,
  CreateRunEnvelopeSchema,
  CreateRunRequestSchema,
  EnginesEnvelopeSchema,
  ErrorEnvelopeSchema,
  HealthEnvelopeSchema,
  RunIdParamsSchema,
  RunResultEnvelopeSchema,
  RunSummaryEnvelopeSchema,
} from "./schemas.ts";

const JSON_CONTENT_TYPE = "application/json";
const SSE_CONTENT_TYPE = "text/event-stream";

interface OpenApiInput {
  version: string;
}

export function createOpenApiDocument(input: OpenApiInput): object {
  const registry = new OpenAPIRegistry();

  const healthResponse = registry.register("HealthResponse", HealthEnvelopeSchema);
  const enginesResponse = registry.register("EnginesResponse", EnginesEnvelopeSchema);
  const createRunRequest = registry.register("CreateRunRequest", CreateRunRequestSchema);
  const createRunResponse = registry.register("CreateRunResponse", CreateRunEnvelopeSchema);
  const runSummaryResponse = registry.register(
    "RunSummaryResponse",
    RunSummaryEnvelopeSchema,
  );
  const runResultResponse = registry.register("RunResultResponse", RunResultEnvelopeSchema);
  const cancelRunResponse = registry.register("CancelRunResponse", CancelRunEnvelopeSchema);
  const runIdParams = registry.register("RunIdParams", RunIdParamsSchema);
  const errorResponse = registry.register("ErrorResponse", ErrorEnvelopeSchema);

  registry.registerPath({
    method: "get",
    path: "/global/health",
    summary: "Read server health",
    tags: ["global"],
    responses: {
      200: {
        description: "Service is healthy",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: healthResponse,
          },
        },
      },
      500: {
        description: "Unexpected server error",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: errorResponse,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/doc",
    summary: "Read OpenAPI document",
    tags: ["global"],
    responses: {
      200: {
        description: "OpenAPI 3.1 document",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: z.record(z.string(), z.unknown()),
          },
        },
      },
      500: {
        description: "Unexpected server error",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: errorResponse,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/event",
    summary: "Connect to global server events",
    tags: ["global"],
    responses: {
      200: {
        description: "SSE stream",
        content: {
          [SSE_CONTENT_TYPE]: {
            schema: z.string(),
          },
        },
      },
      401: {
        description: "Authentication required",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: errorResponse,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/engines",
    summary: "List engines and environment validation summaries",
    tags: ["engines"],
    responses: {
      200: {
        description: "Known engines",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: enginesResponse,
          },
        },
      },
      401: {
        description: "Authentication required",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: errorResponse,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/runs",
    summary: "Create a benchmark run",
    tags: ["runs"],
    request: {
      body: {
        required: true,
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: createRunRequest,
          },
        },
      },
    },
    responses: {
      202: {
        description: "Run accepted",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: createRunResponse,
          },
        },
      },
      400: {
        description: "Validation failed",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: errorResponse,
          },
        },
      },
      413: {
        description: "Payload too large",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: errorResponse,
          },
        },
      },
      415: {
        description: "Unsupported content type",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: errorResponse,
          },
        },
      },
      409: {
        description: "Run cannot be created",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: errorResponse,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/runs/{runId}",
    summary: "Read run status",
    tags: ["runs"],
    request: {
      params: runIdParams,
    },
    responses: {
      400: {
        description: "Invalid run identifier",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: errorResponse,
          },
        },
      },
      200: {
        description: "Run status",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: runSummaryResponse,
          },
        },
      },
      404: {
        description: "Run not found",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: errorResponse,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/runs/{runId}/result",
    summary: "Read persisted run result",
    tags: ["runs"],
    request: {
      params: runIdParams,
    },
    responses: {
      400: {
        description: "Invalid run identifier",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: errorResponse,
          },
        },
      },
      200: {
        description: "Run result",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: runResultResponse,
          },
        },
      },
      404: {
        description: "Run not found",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: errorResponse,
          },
        },
      },
      409: {
        description: "Result not ready",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: errorResponse,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/runs/{runId}/cancel",
    summary: "Cancel an active run",
    tags: ["runs"],
    request: {
      params: runIdParams,
    },
    responses: {
      400: {
        description: "Invalid run identifier",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: errorResponse,
          },
        },
      },
      200: {
        description: "Run cancellation acknowledged",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: cancelRunResponse,
          },
        },
      },
      404: {
        description: "Run not found",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: errorResponse,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/runs/{runId}/event",
    summary: "Connect to run events",
    tags: ["runs"],
    request: {
      params: runIdParams,
    },
    responses: {
      400: {
        description: "Invalid run identifier",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: errorResponse,
          },
        },
      },
      200: {
        description: "SSE stream",
        content: {
          [SSE_CONTENT_TYPE]: {
            schema: z.string(),
          },
        },
      },
      404: {
        description: "Run not found",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: errorResponse,
          },
        },
      },
    },
  });

  const generator = new OpenApiGeneratorV31(registry.definitions);

  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "chimera-bench server API",
      version: input.version,
    },
  });
}
