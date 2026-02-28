import { Bonjour } from "bonjour-service";
import type { Service, ServiceConfig } from "bonjour-service";

const MDNS_STARTUP_TIMEOUT_MS = 1000;

export interface MdnsAdvertisementOptions {
  port: number;
  domain: string;
}

export interface MdnsAdvertisementHandle {
  stop(): Promise<void>;
}

export async function startMdnsAdvertisement(
  options: MdnsAdvertisementOptions,
): Promise<MdnsAdvertisementHandle> {
  const bonjour = new Bonjour();
  const normalizedDomain = normalizeDomain(options.domain);
  const serviceType = "chimera-bench";

  const publishConfig: ServiceConfig = {
    name: "chimera-bench",
    type: serviceType,
    protocol: "tcp",
    port: options.port,
    fqdn: `chimera-bench._${serviceType}._tcp.${normalizedDomain}`,
  };

  const service = bonjour.publish(publishConfig);

  let startupState: "confirmed" | "timeout";
  try {
    startupState = await waitForMdnsStartup(service, MDNS_STARTUP_TIMEOUT_MS);
  } catch (error) {
    await stopPublishedService(service, bonjour);
    throw error;
  }

  if (startupState === "timeout") {
    console.warn(
      `[chimera-bench] warning: mDNS advertisement did not confirm startup within ${MDNS_STARTUP_TIMEOUT_MS}ms.`,
    );
  }

  const onServiceError = (error: unknown): void => {
    const message =
      error instanceof Error ? error.message : "mDNS advertisement emitted an unknown error.";
    console.warn(`[chimera-bench] warning: ${message}`);
  };

  service.on("error", onServiceError);

  return {
    stop: async () => {
      service.removeListener("error", onServiceError);
      await stopPublishedService(service, bonjour);
    },
  };
}

async function waitForMdnsStartup(
  service: Service,
  timeoutMs: number,
): Promise<"confirmed" | "timeout"> {
  return new Promise<"confirmed" | "timeout">((resolve, reject) => {
    const settleResolve = (value: "confirmed" | "timeout"): void => {
      clearTimeout(timeout);
      service.removeListener("up", handleUp);
      service.removeListener("error", handleError);
      resolve(value);
    };

    const settleReject = (error: Error): void => {
      clearTimeout(timeout);
      service.removeListener("up", handleUp);
      service.removeListener("error", handleError);
      reject(error);
    };

    const timeout = setTimeout(() => settleResolve("timeout"), timeoutMs);

    const handleUp = (): void => {
      settleResolve("confirmed");
    };

    const handleError = (error: unknown): void => {
      if (error instanceof Error) {
        settleReject(error);
        return;
      }

      settleReject(new Error("mDNS advertisement failed to start."));
    };

    service.on("up", handleUp);
    service.on("error", handleError);
  });
}

function stopPublishedService(service: Service, bonjour: Bonjour): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof service.stop !== "function") {
      bonjour.destroy();
      resolve();
      return;
    }

    service.stop(() => {
      bonjour.destroy();
      resolve();
    });
  });
}

function normalizeDomain(domain: string): string {
  const trimmed = domain.trim().replace(/\.$/, "");
  return trimmed.length > 0 ? trimmed : "local";
}
