/**
 * Server configuration resolution and startup policy enforcement.
 *
 * This module parses CLI/environment input, validates security constraints
 * for loopback vs non-loopback binds, and provides the normalized runtime
 * configuration consumed by server startup.
 */
import { delimiter } from "node:path";
import { isLoopbackHost } from "./network.ts";
import type { ServeCliFlags, ServeConfig } from "./types.ts";

declare const CHIMERA_BENCH_BUILD_VERSION: string | undefined;

const DEFAULT_USERNAME = "chimera";
const FALLBACK_APP_VERSION = "0.0.0";
const PACKAGE_JSON_URL = new URL("../../package.json", import.meta.url);
const MIN_SERVER_PASSWORD_LENGTH = 12;
const COMMON_WEAK_PASSWORDS = new Set([
  "password",
  "password123",
  "admin",
  "changeme",
  "letmein",
  "qwerty",
  "devpass",
]);

let cachedAppVersion: string | null = null;

export class ServeConfigurationError extends Error {}

export async function resolveServeConfig(
  flags: ServeCliFlags,
  env: NodeJS.ProcessEnv,
): Promise<ServeConfig> {
  const password = sanitizeEnv(env.CHIMERA_SERVER_PASSWORD);
  const username = sanitizeEnv(env.CHIMERA_SERVER_USERNAME) ?? DEFAULT_USERNAME;
  const trustProxy = parseBooleanEnv(env.CHIMERA_SERVER_TRUST_PROXY);
  const devMode = parseBooleanEnv(env.CHIMERA_BENCH_DEV);
  const startupWarnings: string[] = [];
  const nonLoopback = !(await isLoopbackHost(flags.hostname));
  const appVersion = await getAppVersion();

  if (!password) {
    startupWarnings.push(
      "CHIMERA_SERVER_PASSWORD is unset; HTTP basic auth is disabled.",
    );
  }

  if (trustProxy) {
    startupWarnings.push(
      "CHIMERA_SERVER_TRUST_PROXY is enabled; only use this behind a trusted reverse proxy that sanitizes forwarding headers.",
    );
  }

  if (devMode) {
    startupWarnings.push(
      "CHIMERA_BENCH_DEV is enabled; verbose request access logs are active.",
    );
  }

  if (password) {
    const passwordIssue = getServerPasswordIssue(password);
    if (passwordIssue) {
      if (nonLoopback) {
        throw new ServeConfigurationError(
          `CHIMERA_SERVER_PASSWORD is too weak for non-loopback binds: ${passwordIssue}. Generate a stronger password (for example: CHIMERA_SERVER_PASSWORD=\"$(openssl rand -base64 24)\").`,
        );
      }

      startupWarnings.push(
        `CHIMERA_SERVER_PASSWORD appears weak (${passwordIssue}). Use a stronger password for shared environments (for example: CHIMERA_SERVER_PASSWORD=\"$(openssl rand -base64 24)\").`,
      );
    }
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
          trustProxy,
        }
      : {
          enabled: false,
          username,
          trustProxy,
        },
    startupWarnings,
    version: appVersion,
    devMode,
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

  const buildVersion = getBuildVersion();
  if (buildVersion) {
    cachedAppVersion = buildVersion;
    return buildVersion;
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

function getBuildVersion(): string | null {
  if (typeof CHIMERA_BENCH_BUILD_VERSION !== "string") {
    return null;
  }

  const normalizedVersion = CHIMERA_BENCH_BUILD_VERSION.trim();
  return normalizedVersion.length > 0 ? normalizedVersion : null;
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

function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
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

function getServerPasswordIssue(password: string): string | null {
  if (password.length < MIN_SERVER_PASSWORD_LENGTH) {
    return `must be at least ${MIN_SERVER_PASSWORD_LENGTH} characters`;
  }

  if (COMMON_WEAK_PASSWORDS.has(password.toLowerCase())) {
    return "matches a commonly used weak password";
  }

  const characterClassCount = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^a-zA-Z0-9]/.test(password),
  ].filter((match) => match).length;

  if (characterClassCount < 3) {
    return "must include at least three character classes (lowercase, uppercase, digits, symbols)";
  }

  return null;
}
