/**
 * Target profile OpenAPI path registration.
 *
 * These route contracts cover target list/create/read/delete behavior and keep
 * request/response schemas centralized for artifact generation.
 */
import {
  JSON_CONTENT_TYPE,
  type OpenApiPathRegistrationInput,
} from "./path-registration-types.ts";

export function registerTargetPaths(input: OpenApiPathRegistrationInput): void {
  const { registry, schemas } = input;

  registry.registerPath({
    method: "get",
    path: "/targets",
    summary: "List SSH target profiles",
    tags: ["targets"],
    responses: {
      200: {
        description: "Known SSH target profiles",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.targetProfilesResponse,
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
        description: "Target profile load failed",
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
    path: "/targets",
    summary: "Create or update an SSH target profile",
    tags: ["targets"],
    request: {
      body: {
        required: true,
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.upsertTargetProfileRequest,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Target profile updated",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.targetProfileResponse,
          },
        },
      },
      201: {
        description: "Target profile created",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.targetProfileResponse,
          },
        },
      },
      400: {
        description: "Target profile validation failed",
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
      500: {
        description: "Target profile persistence failed",
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
    path: "/targets/{id}",
    summary: "Read an SSH target profile",
    tags: ["targets"],
    request: {
      params: schemas.targetProfileIdParams,
    },
    responses: {
      200: {
        description: "Target profile",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.targetProfileResponse,
          },
        },
      },
      400: {
        description: "Invalid target profile id",
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
        description: "Target profile not found",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.errorResponse,
          },
        },
      },
      500: {
        description: "Target profile load failed",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.errorResponse,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/targets/{id}",
    summary: "Delete an SSH target profile",
    tags: ["targets"],
    request: {
      params: schemas.targetProfileIdParams,
    },
    responses: {
      200: {
        description: "Target profile deleted",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.deleteTargetProfileResponse,
          },
        },
      },
      400: {
        description: "Invalid target profile id",
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
        description: "Target profile not found",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.errorResponse,
          },
        },
      },
      500: {
        description: "Target profile delete failed",
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: schemas.errorResponse,
          },
        },
      },
    },
  });
}
