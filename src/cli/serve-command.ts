import { resolveServeConfig } from "../server/config.ts";
import { startServer } from "../server/start-server.ts";
import type { ServerHandle } from "../server/start-server.ts";
import type { ServeCliFlags } from "../server/types.ts";

const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 4096;
const DEFAULT_MDNS_DOMAIN = "chimera.local";

export class ServeCommandUsageError extends Error {}

export function getServeCommandHelp(): string {
  return [
    "Usage: chimera-bench serve [options]",
    "",
    "Options:",
    "  --hostname <host>      Bind hostname (default: 127.0.0.1)",
    "  --port <number>        Bind port (default: 4096)",
    "  --cors <origin>        Add CORS allowlist origin (repeatable)",
    "  --mdns                 Advertise _chimera-bench._tcp via mDNS",
    "  --mdns-domain <name>   mDNS domain (default: chimera.local)",
    "  -h, --help             Show this help",
  ].join("\n");
}

export async function runServeCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(getServeCommandHelp());
    return;
  }

  const flags = parseServeFlags(args);
  const config = await resolveServeConfig(flags, process.env);

  for (const warning of config.startupWarnings) {
    console.warn(`[chimera-bench] warning: ${warning}`);
  }

  const server = await startServer(config);

  console.log(
    `[chimera-bench] listening on http://${config.hostname}:${server.resolvedPort}`,
  );

  if (config.auth.enabled) {
    console.log(`[chimera-bench] basic auth enabled for user '${config.auth.username}'.`);
  }

  if (config.corsAllowlist.length > 0) {
    console.log(
      `[chimera-bench] CORS allowlist: ${config.corsAllowlist.join(", ")}`,
    );
  }

  if (config.mdns) {
    console.log(
      `[chimera-bench] mDNS advertisement enabled (_chimera-bench._tcp, domain: ${config.mdnsDomain}).`,
    );
  }

  await waitForShutdownSignal(server);
}

function parseServeFlags(args: string[]): ServeCliFlags {
  const flags: ServeCliFlags = {
    hostname: DEFAULT_HOSTNAME,
    port: DEFAULT_PORT,
    corsOrigins: [],
    mdns: false,
    mdnsDomain: DEFAULT_MDNS_DOMAIN,
  };

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];

    if (!current) {
      continue;
    }

    if (current === "--") {
      continue;
    }

    if (current === "--hostname") {
      const value = args[index + 1];
      if (!value) {
        throw new ServeCommandUsageError("--hostname requires a value.");
      }

      flags.hostname = value;
      index += 1;
      continue;
    }

    if (current.startsWith("--hostname=")) {
      const value = current.slice("--hostname=".length).trim();
      if (!value) {
        throw new ServeCommandUsageError("--hostname requires a non-empty value.");
      }

      flags.hostname = value;
      continue;
    }

    if (current === "--port") {
      const value = args[index + 1];
      if (!value) {
        throw new ServeCommandUsageError("--port requires a value.");
      }

      flags.port = parsePort(value);
      index += 1;
      continue;
    }

    if (current.startsWith("--port=")) {
      const value = current.slice("--port=".length).trim();
      flags.port = parsePort(value);
      continue;
    }

    if (current === "--cors") {
      const value = args[index + 1];
      if (!value) {
        throw new ServeCommandUsageError("--cors requires an origin value.");
      }

      flags.corsOrigins.push(value);
      index += 1;
      continue;
    }

    if (current.startsWith("--cors=")) {
      const value = current.slice("--cors=".length).trim();
      if (!value) {
        throw new ServeCommandUsageError("--cors requires an origin value.");
      }

      flags.corsOrigins.push(value);
      continue;
    }

    if (current === "--mdns") {
      flags.mdns = true;
      continue;
    }

    if (current === "--mdns-domain") {
      const value = args[index + 1];
      if (!value) {
        throw new ServeCommandUsageError("--mdns-domain requires a value.");
      }

      flags.mdnsDomain = value;
      index += 1;
      continue;
    }

    if (current.startsWith("--mdns-domain=")) {
      const value = current.slice("--mdns-domain=".length).trim();
      if (!value) {
        throw new ServeCommandUsageError("--mdns-domain requires a non-empty value.");
      }

      flags.mdnsDomain = value;
      continue;
    }

    throw new ServeCommandUsageError(`Unknown option: ${current}`);
  }

  return flags;
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ServeCommandUsageError(
      `Invalid port '${value}'. Expected an integer between 1 and 65535.`,
    );
  }

  return port;
}

async function waitForShutdownSignal(server: ServerHandle): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let inShutdown = false;

    const shutdown = (signal: string): void => {
      if (inShutdown) {
        return;
      }

      inShutdown = true;
      cleanupSignalHandlers();
      console.log(`[chimera-bench] received ${signal}, shutting down...`);
      void server
        .stop(signal)
        .then(() => {
          console.log("[chimera-bench] shutdown complete.");
          resolve();
        })
        .catch(reject);
    };

    const onSigint = (): void => shutdown("SIGINT");
    const onSigterm = (): void => shutdown("SIGTERM");

    const cleanupSignalHandlers = (): void => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };

    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  });
}
