import { z } from "zod";
import {
  JSON_CONTENT_TYPE,
  SSE_CONTENT_TYPE,
  type OpenApiPathRegistrationInput,
} from "./path-registration-types.ts";

export function registerGlobalAndEnginePaths(
  input: OpenApiPathRegistrationInput,
): void {
  const { registry, schemas } = input;

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
            schema: schemas.healthResponse,
          },
        },
      },
      500: {
        description: "Unexpected server error",
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
            schema: schemas.errorResponse,
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
            schema: schemas.errorResponse,
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
            schema: schemas.enginesResponse,
          },
        },
      },
      401: {
        description: "Authentication required",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.errorResponse,
          },
        },
      },
    },
  });
}
