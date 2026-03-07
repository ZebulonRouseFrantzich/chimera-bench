import { describe, expect, test } from "bun:test";
import { delimiter } from "node:path";
import { TEST_APP_VERSION } from "./helpers/app-version.ts";
import {
  resolveServeConfig,
  ServeConfigurationError,
} from "../src/server/config.ts";
import { DEFAULT_MODEL_DIGEST_CACHE_MAX_ENTRIES } from "../src/server/runs/model-digest-service.ts";
import type { ServeCliFlags } from "../src/server/types.ts";

const DEFAULT_FLAGS: ServeCliFlags = {
  hostname: "127.0.0.1",
  port: 4096,
  corsOrigins: [],
  mdns: false,
  mdnsDomain: "chimera.local",
};
const STRONG_SERVER_PASSWORD = "Sup3rSecurePassphrase!";

describe("resolveServeConfig", () => {
  test("warns when auth is not configured", async () => {
    const config = await resolveServeConfig(DEFAULT_FLAGS, {});

    expect(config.auth.enabled).toBe(false);
    expect(config.auth.username).toBe("chimera");
    expect(config.devMode).toBe(false);
    expect(config.startupWarnings.length).toBe(1);
    expect(config.version).toBe(TEST_APP_VERSION);
  });

  test("enables dev mode when CHIMERA_BENCH_DEV is set", async () => {
    const config = await resolveServeConfig(DEFAULT_FLAGS, {
      CHIMERA_BENCH_DEV: "1",
    });

    expect(config.devMode).toBe(true);
    expect(
      config.startupWarnings.some((warning) => warning.includes("CHIMERA_BENCH_DEV")),
    ).toBe(true);
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
          CHIMERA_SERVER_PASSWORD: STRONG_SERVER_PASSWORD,
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
        CHIMERA_SERVER_PASSWORD: STRONG_SERVER_PASSWORD,
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
        CHIMERA_SERVER_PASSWORD: STRONG_SERVER_PASSWORD,
        CHIMERA_MODEL_ROOTS: ["/models", "/other-models"].join(delimiter),
      },
    );

    expect(config.modelRoots).toEqual(["/models", "/other-models"]);
  });

  test("parses workload roots using path delimiter", async () => {
    const config = await resolveServeConfig(DEFAULT_FLAGS, {
      CHIMERA_WORKLOAD_ROOTS: ["/workloads", "/extra-workloads"].join(delimiter),
    });

    expect(config.workloadRoots).toEqual(["/workloads", "/extra-workloads"]);
  });

  test("uses default model digest cache size when env is unset", async () => {
    const config = await resolveServeConfig(DEFAULT_FLAGS, {});

    expect(config.modelDigestCacheMaxEntries).toBe(DEFAULT_MODEL_DIGEST_CACHE_MAX_ENTRIES);
  });

  test("parses model digest cache size as a non-negative integer", async () => {
    const config = await resolveServeConfig(DEFAULT_FLAGS, {
      CHIMERA_MODEL_DIGEST_CACHE_MAX_ENTRIES: "0",
    });

    expect(config.modelDigestCacheMaxEntries).toBe(0);
  });

  test("rejects invalid model digest cache size", async () => {
    await expect(
      resolveServeConfig(DEFAULT_FLAGS, {
        CHIMERA_MODEL_DIGEST_CACHE_MAX_ENTRIES: "-1",
      }),
    ).rejects.toThrow("CHIMERA_MODEL_DIGEST_CACHE_MAX_ENTRIES");
  });

  test("enables trust proxy mode when configured", async () => {
    const config = await resolveServeConfig(DEFAULT_FLAGS, {
      CHIMERA_SERVER_PASSWORD: STRONG_SERVER_PASSWORD,
      CHIMERA_SERVER_TRUST_PROXY: "true",
    });

    expect(config.auth.enabled).toBe(true);
    expect(config.auth.trustProxy).toBe(true);
    expect(
      config.startupWarnings.some((warning) => warning.includes("CHIMERA_SERVER_TRUST_PROXY")),
    ).toBe(true);
  });

  test("warns on weak password for loopback binds", async () => {
    const config = await resolveServeConfig(DEFAULT_FLAGS, {
      CHIMERA_SERVER_PASSWORD: "devpass",
    });

    expect(config.auth.enabled).toBe(true);
    expect(
      config.startupWarnings.some((warning) => warning.includes("appears weak")),
    ).toBe(true);
  });

  test("rejects weak password for non-loopback binds", async () => {
    await expect(
      resolveServeConfig(
        {
          ...DEFAULT_FLAGS,
          hostname: "0.0.0.0",
        },
        {
          CHIMERA_SERVER_PASSWORD: "devpass",
          CHIMERA_MODEL_ROOTS: ["/models"].join(delimiter),
        },
      ),
    ).rejects.toThrow("too weak");
  });
});
