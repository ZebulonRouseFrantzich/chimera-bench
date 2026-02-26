import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type { BasicAuthSettings } from "../types.ts";

const AUTH_REALM = 'Basic realm="chimera-bench"';
const AUTH_WINDOW_MS = 60_000;
const AUTH_MAX_FAILURES = 10;
const RETRY_AFTER_SECONDS = Math.ceil(AUTH_WINDOW_MS / 1000);

export function basicAuthMiddleware(auth: BasicAuthSettings): MiddlewareHandler {
  if (!auth.enabled || !auth.password) {
    return async (_context, next) => {
      await next();
    };
  }

  const configuredPassword = auth.password;
  const limiter = new AuthFailureLimiter(AUTH_MAX_FAILURES, AUTH_WINDOW_MS);

  return async (context, next) => {
    if (context.req.method === "OPTIONS") {
      await next();
      return;
    }

    const now = Date.now();
    const clientKey = getClientKey(context);

    if (limiter.isBlocked(clientKey, now)) {
      return rateLimited(context);
    }

    const authorization = context.req.header("Authorization");
    if (!authorization || !authorization.startsWith("Basic ")) {
      limiter.recordFailure(clientKey, now);

      if (limiter.isBlocked(clientKey, now)) {
        return rateLimited(context);
      }

      return unauthorized(context);
    }

    let decodedCredentials: string;

    try {
      decodedCredentials = Buffer.from(authorization.slice(6), "base64").toString(
        "utf8",
      );
    } catch {
      limiter.recordFailure(clientKey, now);

      if (limiter.isBlocked(clientKey, now)) {
        return rateLimited(context);
      }

      return unauthorized(context);
    }

    const separatorIndex = decodedCredentials.indexOf(":");

    if (separatorIndex < 0) {
      limiter.recordFailure(clientKey, now);

      if (limiter.isBlocked(clientKey, now)) {
        return rateLimited(context);
      }

      return unauthorized(context);
    }

    const username = decodedCredentials.slice(0, separatorIndex);
    const password = decodedCredentials.slice(separatorIndex + 1);

    if (
      !secureEquals(username, auth.username) ||
      !secureEquals(password, configuredPassword)
    ) {
      limiter.recordFailure(clientKey, now);

      if (limiter.isBlocked(clientKey, now)) {
        return rateLimited(context);
      }

      return unauthorized(context);
    }

    limiter.clear(clientKey);

    await next();
  };
}

class AuthFailureLimiter {
  private readonly records = new Map<string, AuthFailureRecord>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
  ) {}

  isBlocked(key: string, now: number): boolean {
    const record = this.records.get(key);
    if (!record) {
      return false;
    }

    if (now >= record.windowEndsAt) {
      this.records.delete(key);
      return false;
    }

    return record.failures > this.maxFailures;
  }

  recordFailure(key: string, now: number): void {
    const existing = this.records.get(key);

    if (!existing || now >= existing.windowEndsAt) {
      this.records.set(key, {
        failures: 1,
        windowEndsAt: now + this.windowMs,
      });
      return;
    }

    existing.failures += 1;
  }

  clear(key: string): void {
    this.records.delete(key);
  }
}

interface AuthFailureRecord {
  failures: number;
  windowEndsAt: number;
}

function unauthorized(context: Context): Response {
  context.header("WWW-Authenticate", AUTH_REALM);
  return context.json(
    {
      success: false,
      error: {
        code: "AUTH_REQUIRED",
        message: "Valid HTTP basic auth credentials are required.",
      },
    },
    401,
  );
}

function rateLimited(context: Context): Response {
  context.header("Retry-After", String(RETRY_AFTER_SECONDS));
  context.header("WWW-Authenticate", AUTH_REALM);

  return context.json(
    {
      success: false,
      error: {
        code: "AUTH_RATE_LIMITED",
        message: "Too many authentication failures. Please retry later.",
      },
    },
    429,
  );
}

function getClientKey(context: Context): string {
  const forwardedFor = context.req.header("X-Forwarded-For");
  if (forwardedFor) {
    const firstAddress = forwardedFor
      .split(",")
      .map((value) => value.trim())
      .find((value) => value.length > 0);

    if (firstAddress) {
      return firstAddress;
    }
  }

  const realIp = context.req.header("X-Real-IP");
  if (realIp) {
    const trimmed = realIp.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return "unknown-client";
}

function secureEquals(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();

  return timingSafeEqual(leftDigest, rightDigest);
}
