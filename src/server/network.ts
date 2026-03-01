import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export async function isLoopbackHost(hostname: string): Promise<boolean> {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    return false;
  }

  const resolvedAddresses = await resolveAddresses(normalized);
  if (resolvedAddresses.length === 0) {
    return false;
  }

  return resolvedAddresses.every(isLoopbackAddress);
}

function isLoopbackAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address.trim().toLowerCase());

  return isIpv4Loopback(normalized) || isIpv6Loopback(normalized);
}

function isIpv4Loopback(address: string): boolean {
  if (!address.startsWith("127.")) {
    return false;
  }

  const segments = address.split(".");
  if (segments.length !== 4) {
    return false;
  }

  return segments.every((segment) => {
    const value = Number.parseInt(segment, 10);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

function isIpv6Loopback(address: string): boolean {
  if (address === "::1" || address === "0:0:0:0:0:0:0:1") {
    return true;
  }

  if (!address.startsWith("::ffff:")) {
    return false;
  }

  return isIpv4Loopback(address.slice("::ffff:".length));
}

async function resolveAddresses(hostname: string): Promise<string[]> {
  const ipType = isIP(stripIpv6Brackets(hostname));
  if (ipType !== 0) {
    return [stripIpv6Brackets(hostname)];
  }

  try {
    const records = await lookup(hostname, {
      all: true,
      verbatim: true,
    });

    return records.map((record) => record.address);
  } catch {
    return [];
  }
}

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }

  return hostname;
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase();
}
