import { describe, expect, test } from "bun:test";
import {
  parseGpuSelectionHints,
  parseSupportedServerFlags,
} from "../../src/server/engines/starter-engine/help-discovery.ts";

describe("starter-engine help discovery", () => {
  test("parses mixed-GPU selector candidates from llama-server help output", () => {
    const hints = parseGpuSelectionHints(`
ggml_backend_hip_init: found 2 ROCm devices:
  Device 0: AMD Radeon RX 6800 XT
  Device 1: AMD Radeon Graphics
`);

    expect(hints.gpuDeviceCount).toBe(2);
    expect(hints.mainGpuIndices).toEqual([0, 1]);
    expect(hints.deviceIdentifiers).toEqual(["ROCm0", "ROCm1"]);
  });

  test("synthesizes selector candidates when only generic CUDA count is present", () => {
    const hints = parseGpuSelectionHints("ggml_backend_cuda_init: found 2 CUDA devices");

    expect(hints.gpuDeviceCount).toBe(2);
    expect(hints.mainGpuIndices).toEqual([0, 1]);
    expect(hints.deviceIdentifiers).toEqual(["CUDA0", "CUDA1"]);
  });

  test("uses explicit backend identifiers even without device-count lines", () => {
    const hints = parseGpuSelectionHints("available devices: CUDA3 CUDA5");

    expect(hints.gpuDeviceCount).toBe(2);
    expect(hints.mainGpuIndices).toEqual([0, 1]);
    expect(hints.deviceIdentifiers).toEqual(["CUDA3", "CUDA5"]);
  });

  test("accepts alternative GPU line formats", () => {
    const hints = parseGpuSelectionHints(`
detected 2 rocm devices
GPU #0: gfx1030
GPU #1: gfx1030
`);

    expect(hints.gpuDeviceCount).toBe(2);
    expect(hints.mainGpuIndices).toEqual([0, 1]);
    expect(hints.deviceIdentifiers).toEqual(["ROCm0", "ROCm1"]);
  });

  test("returns empty hints when no GPU topology can be inferred", () => {
    const hints = parseGpuSelectionHints("llama-server usage: --help");

    expect(hints.gpuDeviceCount).toBe(0);
    expect(hints.mainGpuIndices).toEqual([]);
    expect(hints.deviceIdentifiers).toEqual([]);
  });

  test("parses multi-character short flags from help output", () => {
    const supportedFlags = parseSupportedServerFlags(`
usage:
  -sm, --split-mode <none|layer>
  -mg, --main-gpu <index>
  -dev, --device <dev1,dev2>
  --ctx-size <tokens>
`);

    expect(supportedFlags.has("-sm")).toBe(true);
    expect(supportedFlags.has("-mg")).toBe(true);
    expect(supportedFlags.has("-dev")).toBe(true);
    expect(supportedFlags.has("--split-mode")).toBe(true);
    expect(supportedFlags.has("--main-gpu")).toBe(true);
    expect(supportedFlags.has("--device")).toBe(true);
    expect(supportedFlags.has("--ctx-size")).toBe(true);
  });

  test("does not treat negative numeric tokens as short flags", () => {
    const supportedFlags = parseSupportedServerFlags(
      "args: --temp -0.5 --presence-penalty=-1 --seed -1",
    );

    expect(supportedFlags.has("-0")).toBe(false);
    expect(supportedFlags.has("-1")).toBe(false);
    expect(supportedFlags.has("--temp")).toBe(true);
    expect(supportedFlags.has("--presence-penalty")).toBe(true);
    expect(supportedFlags.has("--seed")).toBe(true);
  });
});
