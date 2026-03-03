/**
 * Basic auth middleware with bounded per-client rate limiting.
 *
 * This module performs constant-time credential checks, optional proxy-aware
 * client keying, and conservative 401/429 response behavior.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { jsonError } from "../api/envelope.ts";
import type { BasicAuthSettings } from "../types.ts";

const AUTH_REALM = "Basic realm=\"chimera-bench\"";
const AUTH_WINDOW_MS = 60_000;
const AUTH_MAX_FAILURES = 10;
const AUTH_MAX_TRACKED_CLIENTS = 5000;
const AUTH_CLEANUP_INTERVAL = 128;
const RETRY_AFTER_SECONDS = Math.ceil(AUTH_WINDOW_MS / 1000);
const DIRECT_CLIENT_KEY = "direct-client";

export function basicAuthMiddleware(auth: BasicAuthSettings): MiddlewareHandler {
  if (!auth.enabled || !auth.password) {
    return async (_context, next) => {
      await next();
    };
  }

  const configuredPassword = auth.password;
  const trustProxyHeaders = auth.trustProxy === true;
  const limiter = new AuthFailureLimiter(
    AUTH_MAX_FAILURES,
    AUTH_WINDOW_MS,
    AUTH_MAX_TRACKED_CLIENTS,
    AUTH_CLEANUP_INTERVAL,
  );

  return async (context, next) => {
    if (context.req.method === "OPTIONS") {
      await next();
      return;
    }

    const now = Date.now();
    const clientKey = getClientKey(context, trustProxyHeaders);

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
  private operationCounter = 0;

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
    private readonly maxTrackedClients: number,
    private readonly cleanupInterval: number,
  ) {}

  isBlocked(key: string, now: number): boolean {
    this.maybeCleanup(now);

    const record = this.records.get(key);
    if (!record) {
      return false;
    }

    if (now >= record.windowEndsAt) {
      this.records.delete(key);
      return false;
    }

    this.touchRecord(key, record, now);

    return record.failures > this.maxFailures;
  }

  recordFailure(key: string, now: number): void {
    this.maybeCleanup(now);

    const existing = this.records.get(key);

    if (!existing || now >= existing.windowEndsAt) {
      this.ensureCapacity(now, key);

      const record: AuthFailureRecord = {
        failures: 1,
        windowEndsAt: now + this.windowMs,
        updatedAt: now,
      };

      this.records.set(key, record);
      return;
    }

    existing.failures += 1;
    this.touchRecord(key, existing, now);
  }

  clear(key: string): void {
    this.records.delete(key);
  }

  private maybeCleanup(now: number): void {
    this.operationCounter += 1;

    if (this.operationCounter % this.cleanupInterval !== 0) {
      return;
    }

    this.pruneExpired(now);
  }

  private pruneExpired(now: number): void {
    for (const [key, record] of this.records) {
      if (now >= record.windowEndsAt) {
        this.records.delete(key);
      }
    }
  }

  private ensureCapacity(now: number, key: string): void {
    if (this.records.has(key) || this.records.size < this.maxTrackedClients) {
      return;
    }

    this.pruneExpired(now);

    while (this.records.size >= this.maxTrackedClients) {
      const oldestKey = this.records.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }

      this.records.delete(oldestKey);
    }
  }

  private touchRecord(key: string, record: AuthFailureRecord, now: number): void {
    record.updatedAt = now;
    this.records.delete(key);
    this.records.set(key, record);
  }
}

interface AuthFailureRecord {
  failures: number;
  windowEndsAt: number;
  updatedAt: number;
}

function unauthorized(context: Context): Response {
  context.header("WWW-Authenticate", AUTH_REALM);
  return jsonError(context, 401, {
    code: "AUTH_REQUIRED",
    message: "Valid HTTP basic auth credentials are required.",
  });
}

function rateLimited(context: Context): Response {
  context.header("Retry-After", String(RETRY_AFTER_SECONDS));
  context.header("WWW-Authenticate", AUTH_REALM);

  return jsonError(context, 429, {
    code: "AUTH_RATE_LIMITED",
    message: "Too many authentication failures. Please retry later.",
  });
}

function getClientKey(context: Context, trustProxyHeaders: boolean): string {
  if (!trustProxyHeaders) {
    return DIRECT_CLIENT_KEY;
  }

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

  return DIRECT_CLIENT_KEY;
}

function secureEquals(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();

  return timingSafeEqual(leftDigest, rightDigest);
}
