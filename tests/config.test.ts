import { describe, expect, test } from "bun:test";
import { delimiter } from "node:path";
import {
  resolveServeConfig,
  ServeConfigurationError,
} from "../src/server/config.ts";
import type { ServeCliFlags } from "../src/server/types.ts";

const DEFAULT_FLAGS: ServeCliFlags = {
  hostname: "127.0.0.1",
  port: 4096,
  corsOrigins: [],
  mdns: false,
  mdnsDomain: "chimera.local",
};

describe("resolveServeConfig", () => {
  test("warns when auth is not configured", async () => {
    const config = await resolveServeConfig(DEFAULT_FLAGS, {});

    expect(config.auth.enabled).toBe(false);
    expect(config.auth.username).toBe("chimera");
    expect(config.startupWarnings.length).toBe(1);
    expect(config.version).toBe("0.1.0");
  });

  test("rejects non-loopback bind when auth is disabled", async () => {
    await expect(
      resolveServeConfig(
        {
          ...DEFAULT_FLAGS,
          hostname: "0.0.0.0",
        },
        {},
      ),
    ).rejects.toThrow(ServeConfigurationError);
  });

  test("rejects non-loopback bind without model roots", async () => {
    await expect(
      resolveServeConfig(
        {
          ...DEFAULT_FLAGS,
          hostname: "0.0.0.0",
        },
        {
          CHIMERA_SERVER_PASSWORD: "devpass",
        },
      ),
    ).rejects.toThrow("CHIMERA_MODEL_ROOTS");
  });

  test("accepts non-loopback bind with auth and model roots", async () => {
    const config = await resolveServeConfig(
      {
        ...DEFAULT_FLAGS,
        hostname: "0.0.0.0",
      },
      {
        CHIMERA_SERVER_PASSWORD: "devpass",
        CHIMERA_MODEL_ROOTS: ["/models", "/more-models"].join(delimiter),
      },
    );

    expect(config.auth.enabled).toBe(true);
    expect(config.modelRoots).toEqual([
      "/models",
      "/more-models",
    ]);
  });

  test("normalizes and deduplicates cors origins", async () => {
    const config = await resolveServeConfig(
      {
        ...DEFAULT_FLAGS,
        corsOrigins: [
          "http://localhost:5173",
          "http://localhost:5173/",
          "https://example.com/path",
        ],
      },
      {},
    );

    expect(config.corsAllowlist).toEqual([
      "http://localhost:5173",
      "https://example.com",
    ]);
  });

  test("parses model roots using path delimiter", async () => {
    const config = await resolveServeConfig(
      {
        ...DEFAULT_FLAGS,
        hostname: "0.0.0.0",
      },
      {
        CHIMERA_SERVER_PASSWORD: "devpass",
        CHIMERA_MODEL_ROOTS: ["/models", "/other-models"].join(delimiter),
      },
    );

    expect(config.modelRoots).toEqual(["/models", "/other-models"]);
  });
});
