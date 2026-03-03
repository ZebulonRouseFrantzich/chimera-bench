import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

export const JSON_CONTENT_TYPE = "application/json";
export const SSE_CONTENT_TYPE = "text/event-stream";

export type OpenApiRouteParamsSchema = z.ZodObject<z.ZodRawShape>;

export interface OpenApiPathSchemas {
  readonly healthResponse: z.ZodTypeAny;
  readonly enginesResponse: z.ZodTypeAny;
  readonly createRunRequest: z.ZodTypeAny;
  readonly createRunResponse: z.ZodTypeAny;
  readonly runSummaryResponse: z.ZodTypeAny;
  readonly runResultResponse: z.ZodTypeAny;
  readonly cancelRunResponse: z.ZodTypeAny;
  readonly targetProfileResponse: z.ZodTypeAny;
  readonly targetProfilesResponse: z.ZodTypeAny;
  readonly deleteTargetProfileResponse: z.ZodTypeAny;
  readonly upsertTargetProfileRequest: z.ZodTypeAny;
  readonly runIdParams: OpenApiRouteParamsSchema;
  readonly targetProfileIdParams: OpenApiRouteParamsSchema;
  readonly errorResponse: z.ZodTypeAny;
}

export interface OpenApiPathRegistrationInput {
  readonly registry: OpenAPIRegistry;
  readonly schemas: OpenApiPathSchemas;
}
