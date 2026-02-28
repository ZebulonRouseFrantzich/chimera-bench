import type { Hono } from "hono";
import { getOrCreateRequestId, jsonSuccess } from "../api/envelope.ts";
import type { EngineCatalog } from "../engines/engine-catalog.ts";
import type {
  EngineEnvironmentSummary,
  EnginePlugin,
} from "../engines/engine-plugin.ts";

const DEFAULT_ENGINE_ENVIRONMENT_VALIDATION_TIMEOUT_MS = 5_000;
const DEFAULT_ENGINE_ENVIRONMENT_CACHE_TTL_MS = 5_000;
const DEFAULT_ENGINE_ENVIRONMENT_ERROR_CACHE_TTL_MS = 1_000;

export interface EngineEnvironmentValidationSettings {
  timeoutMs?: number;
  successCacheTtlMs?: number;
  errorCacheTtlMs?: number;
  now?: () => number;
}

interface RegisterEngineRoutesOptions {
  engines: EngineCatalog;
  environmentValidation?: EngineEnvironmentValidationSettings;
}

interface CachedEngineEnvironmentSummary {
  expiresAtMs: number;
  value: EngineEnvironmentSummary;
}

interface EngineEnvironmentValidationCache {
  load(plugin: EnginePlugin, requestId: string): Promise<EngineEnvironmentSummary>;
}

export function registerEngineRoutes(
  app: Hono,
  options: RegisterEngineRoutesOptions,
): void {
  const environmentValidationCache = createEnvironmentValidationCache(
    options.environmentValidation,
  );

  app.get("/engines", async (context) => {
    const requestId = getOrCreateRequestId(context);

    const engines = await Promise.all(
      options.engines.list().map(async (plugin) => {
        const environment = await environmentValidationCache.load(plugin, requestId);

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

function createEnvironmentValidationCache(
  settings?: EngineEnvironmentValidationSettings,
): EngineEnvironmentValidationCache {
  const timeoutMs =
    settings?.timeoutMs ?? DEFAULT_ENGINE_ENVIRONMENT_VALIDATION_TIMEOUT_MS;
  const successCacheTtlMs =
    settings?.successCacheTtlMs ?? DEFAULT_ENGINE_ENVIRONMENT_CACHE_TTL_MS;
  const errorCacheTtlMs =
    settings?.errorCacheTtlMs ?? DEFAULT_ENGINE_ENVIRONMENT_ERROR_CACHE_TTL_MS;
  const now = settings?.now ?? Date.now;

  const environmentCache = new Map<string, CachedEngineEnvironmentSummary>();
  const environmentValidationInFlight = new Map<
    string,
    Promise<EngineEnvironmentSummary>
  >();

  return {
    async load(plugin: EnginePlugin, requestId: string): Promise<EngineEnvironmentSummary> {
      const currentTimeMs = now();
      const cached = environmentCache.get(plugin.id);
      if (cached && cached.expiresAtMs > currentTimeMs) {
        return cached.value;
      }

      const existingInFlightValidation = environmentValidationInFlight.get(plugin.id);
      if (existingInFlightValidation) {
        return existingInFlightValidation;
      }

      const validationPromise = safeValidateEnvironment(plugin, requestId, timeoutMs)
        .then((environment) => {
          const cacheTtlMs =
            environment.status === "error" ? errorCacheTtlMs : successCacheTtlMs;

          if (cacheTtlMs > 0) {
            environmentCache.set(plugin.id, {
              expiresAtMs: now() + cacheTtlMs,
              value: environment,
            });
          } else {
            environmentCache.delete(plugin.id);
          }

          return environment;
        })
        .catch((error) => {
          const reason =
            error instanceof Error
              ? sanitizeLogValue(error.message)
              : "Engine environment validation failed with an unknown error.";

          console.error(
            `[chimera-bench] requestId=${requestId} pluginId=${plugin.id} environmentValidationUnhandledError=${reason}`,
          );

          const fallbackSummary: EngineEnvironmentSummary = {
            status: "error",
            message: buildPublicEnvironmentFailureMessage(plugin.id),
          };

          return fallbackSummary;
        })
        .finally(() => {
          environmentValidationInFlight.delete(plugin.id);
        });

      environmentValidationInFlight.set(plugin.id, validationPromise);
      return validationPromise;
    },
  };
}

async function safeValidateEnvironment(
  plugin: EnginePlugin,
  requestId: string,
  timeoutMs: number,
): Promise<EngineEnvironmentSummary> {
  try {
    return await withTimeout(
      plugin.validateEnvironment(),
      timeoutMs,
      `Engine '${plugin.id}' environment validation timed out after ${timeoutMs}ms.`,
    );
  } catch (error) {
    const reason =
      error instanceof Error
        ? sanitizeLogValue(error.message)
        : "Engine environment validation failed with an unknown error.";

    console.error(
      `[chimera-bench] requestId=${requestId} pluginId=${plugin.id} environmentValidationError=${reason}`,
    );

    return {
      status: "error",
      message: buildPublicEnvironmentFailureMessage(plugin.id),
    };
  }
}

function buildPublicEnvironmentFailureMessage(pluginId: string): string {
  return `Environment validation failed for engine '${pluginId}'. Check server logs for details.`;
}

function sanitizeLogValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ");
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
