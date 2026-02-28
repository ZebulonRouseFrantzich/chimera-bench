import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

export const ResponseMetaSchema = z.object({
  requestId: z.string().uuid(),
});

export const ApiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});

export function successEnvelopeSchema<TData extends z.ZodTypeAny>(
  dataSchema: TData,
) {
  return z.object({
    success: z.literal(true),
    data: dataSchema,
    meta: ResponseMetaSchema,
  });
}

export function errorEnvelopeSchema<TCode extends z.ZodTypeAny>(
  codeSchema: TCode,
) {
  return z.object({
    success: z.literal(false),
    error: z.object({
      code: codeSchema,
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
    meta: ResponseMetaSchema,
  });
}

interface JsonErrorInput {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

const REQUEST_ID_CONTEXT_KEY = "requestId";

export function setRequestId(context: Context, requestId: string): void {
  context.set(REQUEST_ID_CONTEXT_KEY, requestId);
}

export function getOrCreateRequestId(context: Context): string {
  const existing = context.get(REQUEST_ID_CONTEXT_KEY);
  if (typeof existing === "string" && existing.length > 0) {
    return existing;
  }

  const created = randomUUID();
  context.set(REQUEST_ID_CONTEXT_KEY, created);
  return created;
}

export function jsonSuccess<TData>(
  context: Context,
  data: TData,
  status: ContentfulStatusCode = 200,
): Response {
  return context.json(
    {
      success: true,
      data,
      meta: {
        requestId: getOrCreateRequestId(context),
      },
    },
    status,
  );
}

export function jsonError(
  context: Context,
  status: ContentfulStatusCode,
  input: JsonErrorInput,
): Response {
  return context.json(
    {
      success: false,
      error: {
        code: input.code,
        message: input.message,
        ...(input.details ? { details: input.details } : {}),
      },
      meta: {
        requestId: getOrCreateRequestId(context),
      },
    },
    status,
  );
}
