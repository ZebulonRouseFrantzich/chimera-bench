import type { Context } from "hono";
import { z } from "zod";
import { jsonError } from "../api/envelope.ts";
import { RunIdParamsSchema } from "../api/schemas.ts";
import { formatValidationIssues } from "./validation-issues.ts";

export async function parseJsonBody<T>(
  context: Context,
  schema: z.ZodType<T>,
  maxBytes: number,
): Promise<T | Response> {
  const contentType = context.req.header("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return jsonError(context, 415, {
      code: "VALIDATION_CONTENT_TYPE_INVALID",
      message: "Request body content type must be application/json.",
    });
  }

  const payload = await readJsonPayloadWithLimit(context, maxBytes);
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

export function parseRunIdParam(context: Context): string | Response {
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
