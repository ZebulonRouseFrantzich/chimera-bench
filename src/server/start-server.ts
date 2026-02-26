import { createApp } from "./app.ts";
import { startMdnsAdvertisement } from "./mdns.ts";
import { RuntimeControl } from "./runtime-control.ts";
import type { ServeConfig } from "./types.ts";

export interface ServerHandle {
  readonly resolvedPort: number;
  readonly runtime: RuntimeControl;
  stop(reason?: string): Promise<void>;
}

export async function startServer(config: ServeConfig): Promise<ServerHandle> {
  const runtime = new RuntimeControl();
  const app = createApp({
    version: config.version,
    auth: config.auth,
    corsAllowlist: config.corsAllowlist,
    runtime,
  });

  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    fetch: app.fetch,
  });

  const resolvedPort = server.port ?? config.port;

  let mdnsHandle: {
    stop(): Promise<void>;
  } | null = null;

  if (config.mdns) {
    try {
      mdnsHandle = await startMdnsAdvertisement({
        port: resolvedPort,
        domain: config.mdnsDomain,
      });
    } catch (error) {
      server.stop();
      throw error;
    }
  }

  let stoppingPromise: Promise<void> | null = null;

  return {
    resolvedPort,
    runtime,
    stop(reason = "shutdown") {
      if (stoppingPromise) {
        return stoppingPromise;
      }

      stoppingPromise = stopServer({
        runtime,
        server,
        mdnsHandle,
        reason,
      });

      return stoppingPromise;
    },
  };
}

async function stopServer(input: {
  runtime: RuntimeControl;
  server: Bun.Server<unknown>;
  mdnsHandle: {
    stop(): Promise<void>;
  } | null;
  reason: string;
}): Promise<void> {
  input.runtime.stopAcceptingNewRuns();
  await input.runtime.cancelActiveRun(input.reason);
  await input.runtime.cleanupEngineSubprocesses(input.reason);
  input.runtime.closeSseStreams(input.reason);

  if (input.mdnsHandle) {
    await input.mdnsHandle.stop();
  }

  input.server.stop();
}
