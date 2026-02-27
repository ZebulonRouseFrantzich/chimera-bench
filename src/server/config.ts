import { delimiter } from "node:path";
import { isLoopbackHost } from "./network.ts";
import type { ServeCliFlags, ServeConfig } from "./types.ts";

const DEFAULT_USERNAME = "chimera";
const FALLBACK_APP_VERSION = "0.0.0";
const PACKAGE_JSON_URL = new URL("../../package.json", import.meta.url);

let cachedAppVersion: string | null = null;

export class ServeConfigurationError extends Error {}

export async function resolveServeConfig(
  flags: ServeCliFlags,
  env: NodeJS.ProcessEnv,
): Promise<ServeConfig> {
  const password = sanitizeEnv(env.CHIMERA_SERVER_PASSWORD);
  const username = sanitizeEnv(env.CHIMERA_SERVER_USERNAME) ?? DEFAULT_USERNAME;
  const startupWarnings: string[] = [];
  const nonLoopback = !(await isLoopbackHost(flags.hostname));
  const appVersion = await getAppVersion();

  if (!password) {
    startupWarnings.push(
      "CHIMERA_SERVER_PASSWORD is unset; HTTP basic auth is disabled.",
    );
  }

  if (nonLoopback && !password) {
    throw new ServeConfigurationError(
      "Refusing to bind a non-loopback hostname without CHIMERA_SERVER_PASSWORD. Set CHIMERA_SERVER_PASSWORD or bind to 127.0.0.1.",
    );
  }

  const modelRoots = parseModelRoots(env.CHIMERA_MODEL_ROOTS);
  if (nonLoopback && modelRoots.length === 0) {
    throw new ServeConfigurationError(
      "Refusing non-loopback bind without CHIMERA_MODEL_ROOTS. Set CHIMERA_MODEL_ROOTS to a path-delimited list of model root directories.",
    );
  }

  return {
    hostname: flags.hostname,
    port: flags.port,
    corsAllowlist: normalizeCorsOrigins(flags.corsOrigins),
    mdns: flags.mdns,
    mdnsDomain: sanitizeMdnsDomain(flags.mdnsDomain),
    modelRoots,
    auth: password
      ? {
          enabled: true,
          username,
          password,
        }
      : {
          enabled: false,
          username,
        },
    startupWarnings,
    version: appVersion,
  };
}

function parseModelRoots(rawModelRoots: string | undefined): string[] {
  if (!rawModelRoots) {
    return [];
  }

  return rawModelRoots
    .split(delimiter)
    .map((root) => root.trim())
    .filter((root) => root.length > 0);
}

async function getAppVersion(): Promise<string> {
  if (cachedAppVersion) {
    return cachedAppVersion;
  }

  try {
    const packageJson = (await Bun.file(PACKAGE_JSON_URL).json()) as {
      version?: unknown;
    };

    if (typeof packageJson.version === "string") {
      const normalized = packageJson.version.trim();
      if (normalized.length > 0) {
        cachedAppVersion = normalized;
        return normalized;
      }
    }
  } catch {
    // Fall back to a safe placeholder.
  }

  cachedAppVersion = FALLBACK_APP_VERSION;
  return FALLBACK_APP_VERSION;
}

function sanitizeEnv(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeMdnsDomain(domain: string): string {
  const normalized = domain.trim();
  if (!normalized) {
    throw new ServeConfigurationError("--mdns-domain cannot be empty.");
  }

  return normalized;
}

function normalizeCorsOrigins(origins: string[]): string[] {
  const normalized = new Set<string>();

  for (const origin of origins) {
    const trimmed = origin.trim();

    if (!trimmed) {
      throw new ServeConfigurationError("--cors values must not be empty.");
    }

    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(trimmed);
    } catch {
      throw new ServeConfigurationError(
        `Invalid CORS origin '${origin}'. Expected an absolute http(s) origin.`,
      );
    }

    if (
      parsedOrigin.protocol !== "http:" &&
      parsedOrigin.protocol !== "https:"
    ) {
      throw new ServeConfigurationError(
        `Invalid CORS origin '${origin}'. Only http and https origins are supported.`,
      );
    }

    normalized.add(parsedOrigin.origin);
  }

  return Array.from(normalized);
}
