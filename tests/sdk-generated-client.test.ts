import { describe, expect, test } from "bun:test";
import { buildOperationUrl } from "../sdk/generated/client.ts";

describe("generated SDK client URL helpers", () => {
  test("normalizes trailing slashes and substitutes path parameters", () => {
    const url = buildOperationUrl("http://localhost:4096///", "getRunsByRunId", {
      runId: "run_123",
    });

    expect(url).toBe("http://localhost:4096/runs/run_123");
  });

  test("URL-encodes path parameters", () => {
    const url = buildOperationUrl("http://localhost:4096", "getRunsByRunIdEvent", {
      runId: "run value/with spaces",
    });

    expect(url).toBe(
      "http://localhost:4096/runs/run%20value%2Fwith%20spaces/event",
    );
  });

  test("throws when required path parameters are missing", () => {
    expect(() => buildOperationUrl("http://localhost:4096", "getRunsByRunId")).toThrow(
      "Missing path parameter",
    );
  });
});
