import { describe, expect, test } from "bun:test";
import { parseGpuSelectionHints } from "../../src/server/engines/starter-engine/help-discovery.ts";

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
});
