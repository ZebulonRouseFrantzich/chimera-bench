import {
  JSON_CONTENT_TYPE,
  type OpenApiPathRegistrationInput,
} from "./path-registration-types.ts";

export function registerWorkloadPaths(input: OpenApiPathRegistrationInput): void {
  const { registry, schemas } = input;

  registry.registerPath({
    method: "get",
    path: "/workloads",
    summary: "List registered workloads",
    tags: ["workloads"],
    responses: {
      200: {
        description: "Registered built-in and filesystem workloads",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.workloadsResponse,
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
    path: "/workloads/{workloadId}",
    summary: "Read workload metadata or prompt details",
    tags: ["workloads"],
    request: {
      params: schemas.workloadIdParams,
      query: schemas.workloadDetailQuery,
    },
    responses: {
      200: {
        description: "Workload details",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.workloadDetailResponse,
          },
        },
      },
      400: {
        description: "Invalid params or query",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.errorResponse,
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
      404: {
        description: "Workload not found",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.errorResponse,
          },
        },
      },
      413: {
        description: "Response payload too large",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.errorResponse,
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
    method: "post",
    path: "/workloads/reload",
    summary: "Reload filesystem workloads",
    tags: ["workloads"],
    responses: {
      200: {
        description: "Reload complete",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.workloadsReloadResponse,
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
      429: {
        description: "Reload cooldown active",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.errorResponse,
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
}
