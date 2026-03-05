import { describe, expect, test } from "bun:test";
import {
  CreateRunRequestSchema,
  normalizeCreateRunRequest,
} from "../src/server/api/schemas.ts";

describe("api schemas", () => {
  test("fails sweep normalization when axis value cannot be cloned safely", () => {
    const parsed = CreateRunRequestSchema.parse({
      engineId: "llama-cpp",
      target: {
        type: "local",
      },
      model: {
        identifier: "/models/model.gguf",
      },
      sweep: {
        axes: {
          requestParams: {
            temperature: [() => "not-json"],
          },
        },
        maxCases: 1,
      },
    });

    expect(() => {
      normalizeCreateRunRequest(parsed);
    }).toThrow("Failed to clone sweep axis value");
  });
});
