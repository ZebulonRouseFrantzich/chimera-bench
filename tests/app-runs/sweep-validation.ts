import { describe, expect, test } from "bun:test";
import { buildApp, TEST_MODEL_IDENTIFIER } from "./helpers.ts";

function createSweepRequestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engineId: "llama-cpp",
    target: {
      type: "local",
    },
    model: {
      identifier: TEST_MODEL_IDENTIFIER,
    },
    workloadId: "tuning.v0_0_1",
    validationMode: "permissive",
    sweep: {
      axes: {
        serverArgs: {
          ctxSize: [["--ctx-size", "4096"], ["--ctx-size", "8192"]],
        },
        requestParams: {
          max_tokens: [128, 256],
        },
      },
      maxCases: 8,
      repetitions: 1,
    },
    ...overrides,
  };
}

describe("run routes", () => {
  test("accepts valid sweep requests after deterministic expansion and execution wiring", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createSweepRequestBody()),
    });

    expect(response.status).toBe(202);
    const payload = await response.json();
    expect(typeof payload.data?.runId).toBe("string");
  });

  test("still returns sweep validation failures before temporary rejection", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        createSweepRequestBody({
          sweep: {
            axes: {
              requestParams: {
                max_tokens: [1, 2, 3, 4],
              },
            },
            maxCases: 2,
            repetitions: 1,
          },
        }),
      ),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_SWEEP_TOO_LARGE");
  });

  test("returns reserved sweep axis key/flag failures before temporary rejection", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        createSweepRequestBody({
          sweep: {
            axes: {
              serverArgs: {
                bad: [["--port", "1234"]],
              },
              requestParams: {
                messages: [[{ role: "user", content: "x" }]],
              },
            },
            maxCases: 8,
            repetitions: 1,
          },
        }),
      ),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_SWEEP_INVALID");
    expect(payload.error.details.issues).toHaveLength(2);
  });

  test("rewrites request-param budget messages to sweep path context", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        createSweepRequestBody({
          sweep: {
            axes: {
              requestParams: {
                max_tokens: ["x".repeat(9_000)],
              },
            },
            maxCases: 8,
            repetitions: 1,
          },
        }),
      ),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_SWEEP_INVALID");
    expect(payload.error.details.issues[0].message).toContain(
      "sweep.axes.requestParams.max_tokens[0]",
    );
    expect(payload.error.details.issues[0].message).not.toContain("engine.requestParams");
  });

  test("rejects sweep request body when repetitions is not an integer", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        createSweepRequestBody({
          sweep: {
            axes: {
              requestParams: {
                max_tokens: [64],
              },
            },
            maxCases: 8,
            repetitions: 1.5,
          },
        }),
      ),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_BODY_INVALID");
  });

  test("rejects sweep when merged base+sweep serverArgs can exceed the server token ceiling", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const nearLimitServerArgs = Array.from({ length: 64 }, (_value, index) => {
      return `--arg-${index}`;
    });

    const response = await app.request("http://localhost/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        createSweepRequestBody({
          engine: {
            serverArgs: nearLimitServerArgs,
            requestParams: {},
          },
          sweep: {
            axes: {
              serverArgs: {
                threads: [["--threads", "4"]],
              },
              requestParams: {},
            },
            maxCases: 8,
            repetitions: 1,
          },
        }),
      ),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_SWEEP_INVALID");
    expect(payload.error.details.issues[0].path).toBe("sweep.axes.serverArgs");
    expect(payload.error.details.issues[0].message).toContain("Merged serverArgs can exceed 64");
  });

  test("still accepts non-sweep run creation", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        engineId: "llama-cpp",
        target: {
          type: "local",
        },
        model: {
          identifier: TEST_MODEL_IDENTIFIER,
        },
      }),
    });

    expect(response.status).toBe(202);
  });

  test("rejects sweep requests for workloads with multiple workload cases", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        createSweepRequestBody({
          workloadId: "starter.v1",
        }),
      ),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_SWEEP_WORKLOAD_NOT_SUPPORTED");
  });
});
