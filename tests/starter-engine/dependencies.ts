import { describe, expect, test } from "bun:test";
import { createDependencies } from "../../src/server/engines/starter-engine/dependencies.ts";
import { createSshProfile } from "./helpers.ts";

const REMOTE_HELP_OUTPUT = `
ggml_backend_hip_init: found 2 ROCm devices:
  Device 0: AMD Radeon RX 6800 XT
  Device 1: AMD Radeon Graphics
--model
--host
--port
--api-key
--no-webui
--threads
`;

describe("starter-engine dependency caches", () => {
  test("shares one remote help probe between flags and GPU hint discovery", async () => {
    let discoveryCalls = 0;

    const dependencies = createDependencies({
      executeSshCommand: async () => {
        discoveryCalls += 1;
        return {
          argv: ["ssh", "..."],
          stdoutExcerpt: REMOTE_HELP_OUTPUT,
          stderrExcerpt: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      },
      now: () => 1_000,
      remoteHelpCacheTtlMs: 60_000,
    });

    const profile = createSshProfile("lab");
    const [supportedFlags, gpuHints] = await Promise.all([
      dependencies.discoverRemoteSupportedServerFlags(profile),
      dependencies.discoverRemoteGpuSelectionHints(profile),
    ]);

    expect(supportedFlags.has("--threads")).toBe(true);
    expect(gpuHints.gpuDeviceCount).toBe(2);
    expect(gpuHints.deviceIdentifiers).toEqual(["ROCm0", "ROCm1"]);
    expect(discoveryCalls).toBe(1);
  });

  test("evicts oldest remote help cache entries when capacity is exceeded", async () => {
    let discoveryCalls = 0;

    const dependencies = createDependencies({
      executeSshCommand: async () => {
        discoveryCalls += 1;
        return {
          argv: ["ssh", "..."],
          stdoutExcerpt: REMOTE_HELP_OUTPUT,
          stderrExcerpt: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      },
      now: () => 1_000,
      remoteHelpCacheTtlMs: 60_000,
      remoteHelpCacheMaxEntries: 2,
    });

    const profileA = createSshProfile("a");
    const profileB = createSshProfile("b");
    const profileC = createSshProfile("c");

    await dependencies.discoverRemoteSupportedServerFlags(profileA);
    await dependencies.discoverRemoteSupportedServerFlags(profileB);
    await dependencies.discoverRemoteSupportedServerFlags(profileC);
    expect(discoveryCalls).toBe(3);

    await dependencies.discoverRemoteSupportedServerFlags(profileB);
    expect(discoveryCalls).toBe(3);

    await dependencies.discoverRemoteSupportedServerFlags(profileA);
    expect(discoveryCalls).toBe(4);
  });
});
