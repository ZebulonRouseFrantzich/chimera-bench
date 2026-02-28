import { describe, expect, test } from "bun:test";
import { buildApp } from "./helpers/app-fixture.ts";

describe("engine routes", () => {
  test("lists engines with envelope", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/engines");
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.success).toBe(true);
    expect(payload.data.engines).toHaveLength(1);
    expect(payload.data.engines[0].id).toBe("llama-cpp");
  });
});
