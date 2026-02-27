import type { MiddlewareHandler } from "hono";

const ALLOWED_HEADERS = new Map<string, string>([
  ["authorization", "Authorization"],
  ["content-type", "Content-Type"],
  ["accept", "Accept"],
]);
const ALLOWED_METHODS = new Set(["GET", "POST", "OPTIONS"]);

export function corsAllowlistMiddleware(origins: readonly string[]): MiddlewareHandler {
  const allowlist = new Set(origins);

  return async (context, next) => {
    const origin = context.req.header("Origin");
    const requestMethod = context.req.header("Access-Control-Request-Method");
    const isPreflight =
      context.req.method === "OPTIONS" && Boolean(origin) && Boolean(requestMethod);

    if (isPreflight) {
      if (!origin || !allowlist.has(origin)) {
        await next();
        return;
      }

      const normalizedMethod = requestMethod?.toUpperCase() ?? "GET";
      if (!ALLOWED_METHODS.has(normalizedMethod)) {
        return context.json(
          {
            success: false,
            error: {
              code: "CORS_METHOD_NOT_ALLOWED",
              message: `CORS preflight method '${normalizedMethod}' is not allowed.`,
            },
          },
          405,
        );
      }

      const { allowHeaders, invalidHeaders } = buildAllowHeaders(
        context.req.header("Access-Control-Request-Headers"),
      );

      if (invalidHeaders.length > 0) {
        return context.json(
          {
            success: false,
            error: {
              code: "CORS_HEADER_NOT_ALLOWED",
              message: `CORS preflight headers are not allowlisted: ${invalidHeaders.join(", ")}.`,
            },
          },
          400,
        );
      }

      context.header(
        "Vary",
        appendVary(
          appendVary(context.res.headers.get("Vary"), "Origin"),
          "Access-Control-Request-Headers",
        ),
      );
      context.header("Access-Control-Allow-Origin", origin);
      context.header("Access-Control-Allow-Credentials", "true");
      context.header("Access-Control-Allow-Methods", normalizedMethod);
      context.header("Access-Control-Allow-Headers", allowHeaders);
      context.header("Access-Control-Max-Age", "600");

      return context.body(null, 204);
    }

    await next();

    if (!origin || !allowlist.has(origin)) {
      return;
    }

    context.header("Vary", appendVary(context.res.headers.get("Vary"), "Origin"));
    context.header("Access-Control-Allow-Origin", origin);
    context.header("Access-Control-Allow-Credentials", "true");
  };
}

function buildAllowHeaders(
  requestedHeaders: string | undefined,
): {
  allowHeaders: string;
  invalidHeaders: string[];
} {
  const allowed = new Set<string>();
  const invalidHeaders: string[] = [];

  if (!requestedHeaders) {
    return {
      allowHeaders: Array.from(ALLOWED_HEADERS.values()).join(", "),
      invalidHeaders,
    };
  }

  const requested = requestedHeaders
    .split(",")
    .map((header) => header.trim())
    .filter((header) => header.length > 0);

  for (const requestedHeader of requested) {
    const canonical = ALLOWED_HEADERS.get(requestedHeader.toLowerCase());
    if (canonical) {
      allowed.add(canonical);
      continue;
    }

    invalidHeaders.push(requestedHeader);
  }

  return {
    allowHeaders: Array.from(allowed).join(", "),
    invalidHeaders,
  };
}

function appendVary(current: string | null, value: string): string {
  if (!current) {
    return value;
  }

  const values = current
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (values.includes(value)) {
    return values.join(", ");
  }

  values.push(value);
  return values.join(", ");
}
