import type { Hono } from "hono";
import { getOrCreateRequestId, jsonSuccess } from "../api/envelope.ts";
import type { EngineCatalog } from "../engines/engine-catalog.ts";
import type { EnginePlugin } from "../engines/engine-plugin.ts";

const ENGINE_ENVIRONMENT_VALIDATION_TIMEOUT_MS = 5_000;
const ENGINE_ENVIRONMENT_CACHE_TTL_MS = 5_000;

interface RegisterEngineRoutesOptions {
  engines: EngineCatalog;
}

export function registerEngineRoutes(
  app: Hono,
  options: RegisterEngineRoutesOptions,
): void {
  const environmentCache = new Map<
    string,
    {
      expiresAtMs: number;
      value: { status: "ok" | "error" | "unknown"; message?: string };
    }
  >();

  app.get("/engines", async (context) => {
    const requestId = getOrCreateRequestId(context);
    const now = Date.now();

    const engines = await Promise.all(
      options.engines.list().map(async (plugin) => {
        const cached = environmentCache.get(plugin.id);
        const environment =
          cached && cached.expiresAtMs > now
            ? cached.value
            : await safeValidateEnvironment(plugin, requestId);

        if (!cached || cached.expiresAtMs <= now) {
          environmentCache.set(plugin.id, {
            expiresAtMs: now + ENGINE_ENVIRONMENT_CACHE_TTL_MS,
            value: environment,
          });
        }

        return {
          id: plugin.id,
          displayName: plugin.displayName,
          version: plugin.version,
          capabilities: plugin.capabilities,
          environment,
        };
      }),
    );

    return jsonSuccess(context, {
      engines,
    });
  });
}

async function safeValidateEnvironment(
  plugin: EnginePlugin,
  requestId: string,
): Promise<{ status: "ok" | "error" | "unknown"; message?: string }> {
  try {
    return await withTimeout(
      plugin.validateEnvironment(),
      ENGINE_ENVIRONMENT_VALIDATION_TIMEOUT_MS,
      `Engine '${plugin.id}' environment validation timed out after ${ENGINE_ENVIRONMENT_VALIDATION_TIMEOUT_MS}ms.`,
    );
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.message
        : "Engine environment validation failed with an unknown error.";

    console.error(
      `[chimera-bench] requestId=${requestId} pluginId=${plugin.id} environmentValidationError=${reason}`,
    );

    return {
      status: "error",
      message: reason,
    };
  }
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
