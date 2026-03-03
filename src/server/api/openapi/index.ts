/**
 * OpenAPI document construction for the server API.
 *
 * Route contracts and schema registrations in this module are the source of
 * truth for `openapi/openapi.json` and generated SDK operation metadata.
 */
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  DeleteTargetProfileEnvelopeSchema,
  CancelRunEnvelopeSchema,
  CreateRunEnvelopeSchema,
  CreateRunRequestSchema,
  TargetProfileIdParamsSchema,
  TargetProfileEnvelopeSchema,
  TargetProfilesEnvelopeSchema,
  UpsertTargetProfileRequestSchema,
  EnginesEnvelopeSchema,
  ErrorEnvelopeSchema,
  HealthEnvelopeSchema,
  RunIdParamsSchema,
  RunResultEnvelopeSchema,
  RunSummaryEnvelopeSchema,
} from "../schemas.ts";
import type { OpenApiRouteParamsSchema } from "./path-registration-types.ts";
import { registerGlobalAndEnginePaths } from "./register-global-engine-paths.ts";
import { registerRunPaths } from "./register-run-paths.ts";
import { registerTargetPaths } from "./register-target-paths.ts";

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
  const targetProfileResponse = registry.register(
    "TargetProfileResponse",
    TargetProfileEnvelopeSchema,
  );
  const targetProfilesResponse = registry.register(
    "TargetProfilesResponse",
    TargetProfilesEnvelopeSchema,
  );
  const deleteTargetProfileResponse = registry.register(
    "DeleteTargetProfileResponse",
    DeleteTargetProfileEnvelopeSchema,
  );
  const upsertTargetProfileRequest = registry.register(
    "UpsertTargetProfileRequest",
    UpsertTargetProfileRequestSchema,
  );
  const runIdParams = asOpenApiRouteParamsSchema(
    registry.register("RunIdParams", RunIdParamsSchema),
    "RunIdParams",
  );
  const targetProfileIdParams = asOpenApiRouteParamsSchema(
    registry.register("TargetProfileIdParams", TargetProfileIdParamsSchema),
    "TargetProfileIdParams",
  );
  const errorResponse = registry.register("ErrorResponse", ErrorEnvelopeSchema);

  const pathSchemas = {
    healthResponse,
    enginesResponse,
    createRunRequest,
    createRunResponse,
    runSummaryResponse,
    runResultResponse,
    cancelRunResponse,
    targetProfileResponse,
    targetProfilesResponse,
    deleteTargetProfileResponse,
    upsertTargetProfileRequest,
    runIdParams,
    targetProfileIdParams,
    errorResponse,
  };

  registerGlobalAndEnginePaths({
    registry,
    schemas: pathSchemas,
  });
  registerTargetPaths({
    registry,
    schemas: pathSchemas,
  });
  registerRunPaths({
    registry,
    schemas: pathSchemas,
  });

  const generator = new OpenApiGeneratorV31(registry.definitions);

  const document = generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "chimera-bench server API",
      version: input.version,
    },
  });

  addCreateRunTargetDiscriminator(document);
  return document;
}

function addCreateRunTargetDiscriminator(document: object): void {
  const root = asRecord(document);
  if (!root) {
    return;
  }

  const components = asRecord(root.components);
  if (!components) {
    return;
  }

  const schemas = asRecord(components.schemas);
  if (!schemas) {
    return;
  }

  const createRunRequest = asRecord(schemas.CreateRunRequest);
  if (!createRunRequest) {
    return;
  }

  const properties = asRecord(createRunRequest.properties);
  if (!properties) {
    return;
  }

  const target = asRecord(properties.target);
  if (!target) {
    return;
  }

  if (!Array.isArray(target.oneOf)) {
    return;
  }

  target.discriminator = {
    propertyName: "type",
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function asOpenApiRouteParamsSchema(
  schema: z.ZodTypeAny,
  schemaName: string,
): OpenApiRouteParamsSchema {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error(`OpenAPI params schema '${schemaName}' must be a zod object.`);
  }

  return schema;
}
