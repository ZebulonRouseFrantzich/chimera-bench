/**
 * Run lifecycle OpenAPI path registration.
 *
 * These route contracts describe run creation, status/result retrieval,
 * cancellation, and SSE event streaming endpoints.
 */
import { z } from "zod";
import {
  JSON_CONTENT_TYPE,
  SSE_CONTENT_TYPE,
  type OpenApiPathRegistrationInput,
} from "./path-registration-types.ts";

export function registerRunPaths(input: OpenApiPathRegistrationInput): void {
  const { registry, schemas } = input;

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
            schema: schemas.createRunRequest,
          },
        },
      },
    },
    responses: {
      202: {
        description: "Run accepted",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.createRunResponse,
          },
        },
      },
      400: {
        description: "Validation failed",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.errorResponse,
          },
        },
      },
      413: {
        description: "Payload too large",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.errorResponse,
          },
        },
      },
      415: {
        description: "Unsupported content type",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.errorResponse,
          },
        },
      },
      409: {
        description: "Run cannot be created",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.errorResponse,
          },
        },
      },
      500: {
        description:
          "Run creation failed while loading target profile data (TARGET_PROFILE_PERSIST_FAILED)",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.errorResponse,
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
      params: schemas.runIdParams,
    },
    responses: {
      400: {
        description: "Invalid run identifier",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.errorResponse,
          },
        },
      },
      200: {
        description: "Run status",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.runSummaryResponse,
          },
        },
      },
      404: {
        description: "Run not found",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.errorResponse,
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
      params: schemas.runIdParams,
    },
    responses: {
      400: {
        description: "Invalid run identifier",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.errorResponse,
          },
        },
      },
      200: {
        description: "Run result",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.runResultResponse,
          },
        },
      },
      404: {
        description: "Run not found",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.errorResponse,
          },
        },
      },
      409: {
        description: "Result not ready",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.errorResponse,
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
      params: schemas.runIdParams,
    },
    responses: {
      400: {
        description: "Invalid run identifier",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.errorResponse,
          },
        },
      },
      200: {
        description: "Run cancellation acknowledged",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.cancelRunResponse,
          },
        },
      },
      404: {
        description: "Run not found",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.errorResponse,
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
      params: schemas.runIdParams,
    },
    responses: {
      400: {
        description: "Invalid run identifier",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.errorResponse,
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
            schema: schemas.errorResponse,
          },
        },
      },
    },
  });
}
