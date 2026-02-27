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

  const startupState = await waitForMdnsStartup(service, MDNS_STARTUP_TIMEOUT_MS);
  if (startupState === "timeout") {
    console.warn(
      `[chimera-bench] warning: mDNS advertisement did not confirm startup within ${MDNS_STARTUP_TIMEOUT_MS}ms.`,
    );
  }

  return {
    stop: () =>
      new Promise<void>((resolve) => {
        if (typeof service.stop !== "function") {
          bonjour.destroy();
          resolve();
          return;
        }

        service.stop(() => {
          bonjour.destroy();
          resolve();
        });
      }),
  };
}

async function waitForMdnsStartup(
  service: Service,
  timeoutMs: number,
): Promise<"confirmed" | "timeout"> {
  return new Promise<"confirmed" | "timeout">((resolve, reject) => {
    const timeout = setTimeout(() => resolve("timeout"), timeoutMs);

    service.once("up", () => {
      clearTimeout(timeout);
      resolve("confirmed");
    });

    service.once("error", (error: unknown) => {
      clearTimeout(timeout);
      if (error instanceof Error) {
        reject(error);
        return;
      }

      reject(new Error("mDNS advertisement failed to start."));
    });
  });
}

function normalizeDomain(domain: string): string {
  const trimmed = domain.trim().replace(/\.$/, "");
  return trimmed.length > 0 ? trimmed : "local";
}
