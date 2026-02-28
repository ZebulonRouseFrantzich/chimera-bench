import { describe, expect, test } from "bun:test";
import { hasRestrictedEnvironmentOverrides } from "../src/server/engines/engine-plugin.ts";

describe("engine plugin environment override restrictions", () => {
  test("flags linux and node injection variables", () => {
    expect(hasRestrictedEnvironmentOverrides({ LD_PRELOAD: "/tmp/lib.so" })).toBe(true);
    expect(hasRestrictedEnvironmentOverrides({ node_options: "--inspect" })).toBe(true);
    expect(hasRestrictedEnvironmentOverrides({ LD_AUDIT: "/tmp/audit.so" })).toBe(true);
  });

  test("flags macOS dyld injection variables", () => {
    expect(
      hasRestrictedEnvironmentOverrides({ DYLD_INSERT_LIBRARIES: "/tmp/lib.dylib" }),
    ).toBe(true);
    expect(hasRestrictedEnvironmentOverrides({ DYLD_LIBRARY_PATH: "/tmp/lib" })).toBe(
      true,
    );
    expect(
      hasRestrictedEnvironmentOverrides({ DYLD_FORCE_FLAT_NAMESPACE: "1" }),
    ).toBe(true);
  });

  test("allows ordinary environment overrides", () => {
    expect(
      hasRestrictedEnvironmentOverrides({
        PATH: "/usr/bin",
        CHIMERA_TEST_MODE: "1",
      }),
    ).toBe(false);
  });
});
