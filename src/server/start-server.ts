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
    modelRoots: config.modelRoots,
    workloadRoots: config.workloadRoots,
    devMode: config.devMode,
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

  // Run shutdown phases in parallel to reduce total shutdown latency; each
  // phase is best-effort and aggregated via allSettled below.
  const shutdownSteps: Array<Promise<unknown>> = [
    Promise.resolve().then(() => input.runtime.cancelActiveRun(input.reason)),
    Promise.resolve().then(() => input.runtime.cleanupEngineSubprocesses(input.reason)),
    Promise.resolve().then(() => input.runtime.closeSseStreams(input.reason)),
  ];

  if (input.mdnsHandle) {
    const mdnsHandle = input.mdnsHandle;
    shutdownSteps.push(Promise.resolve().then(() => mdnsHandle.stop()));
  }

  let results: PromiseSettledResult<unknown>[] = [];

  try {
    results = await Promise.allSettled(shutdownSteps);
  } finally {
    // Always stop accepting new connections even if one shutdown phase fails.
    input.server.stop();
  }

  const firstRejection = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );

  if (firstRejection) {
    throw toError(firstRejection.reason);
  }
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  return new Error("Server shutdown encountered an unexpected error.");
}
