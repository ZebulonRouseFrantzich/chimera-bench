import { describe, expect, test } from "bun:test";
import { buildApp, TEST_MODEL_IDENTIFIER } from "./helpers.ts";

describe("run routes", () => {
  test("accepts sweep run creation and stores planned sweep totalCases", async () => {
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
        workloadId: "tuning.v0_0_1",
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
          repetitions: 2,
        },
      }),
    });

    expect(response.status).toBe(202);
    const payload = await response.json();
    const runId = payload.data?.runId;
    expect(typeof runId).toBe("string");
    if (typeof runId !== "string") {
      throw new Error("Expected create-run response to include runId.");
    }

    const summaryResponse = await app.request(`http://localhost/runs/${runId}`);
    expect(summaryResponse.status).toBe(200);
    const summaryPayload = await summaryResponse.json();
    expect(summaryPayload.data.summary.totalCases).toBe(8);
  });

  test("rejects sweep payloads with empty axes", async () => {
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
        workloadId: "tuning.v0_0_1",
        sweep: {
          axes: {},
          maxCases: 1,
          repetitions: 1,
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_SWEEP_EMPTY");
  });

  test("rejects sweep payloads where sweep.maxCases exceeds server ceiling", async () => {
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
        workloadId: "tuning.v0_0_1",
        sweep: {
          axes: {
            requestParams: {
              max_tokens: [64],
            },
          },
          maxCases: 257,
          repetitions: 1,
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_SWEEP_TOO_LARGE");
  });

  test("rejects sweep payloads where planned cases exceed maxCases", async () => {
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
        workloadId: "tuning.v0_0_1",
        sweep: {
          axes: {
            requestParams: {
              max_tokens: [64, 128, 256],
            },
          },
          maxCases: 2,
          repetitions: 1,
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_SWEEP_TOO_LARGE");
  });

  test("rejects sweep payloads with reserved server flags", async () => {
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
        workloadId: "tuning.v0_0_1",
        sweep: {
          axes: {
            serverArgs: {
              bad: [["--port", "1234"]],
            },
          },
          maxCases: 8,
          repetitions: 1,
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_SWEEP_INVALID");
    expect(payload.error.details.issues[0].code).toBe("SERVER_ARG_RESERVED");
  });

  test("rejects sweep payloads with reserved request param keys", async () => {
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
        workloadId: "tuning.v0_0_1",
        sweep: {
          axes: {
            requestParams: {
              messages: [[{ role: "user", content: "x" }]],
            },
          },
          maxCases: 8,
          repetitions: 1,
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_SWEEP_INVALID");
    expect(payload.error.details.issues[0].code).toBe("REQUEST_PARAM_RESERVED");
  });

  test("rejects sweep payloads with non-integer repetitions", async () => {
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
        workloadId: "tuning.v0_0_1",
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
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_BODY_INVALID");
    expect(payload.error.details.issues[0].path).toBe("sweep.repetitions");
  });

  test("accepts sweep payloads when planned cases exactly match maxCases at boundary", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const maxTokensAxisValues = Array.from({ length: 256 }, (_, index) => {
      return index + 1;
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
        workloadId: "tuning.v0_0_1",
        sweep: {
          axes: {
            requestParams: {
              max_tokens: maxTokensAxisValues,
            },
          },
          maxCases: 256,
          repetitions: 1,
        },
      }),
    });

    expect(response.status).toBe(202);
  });

  test("rejects sweep payloads for workloads with more than one case", async () => {
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
        workloadId: "starter.v1",
        sweep: {
          axes: {
            requestParams: {
              max_tokens: [64],
            },
          },
          maxCases: 8,
          repetitions: 1,
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_SWEEP_INVALID");
    expect(payload.error.details.issues[0].code).toBe("SWEEP_WORKLOAD_CASE_COUNT_INVALID");
  });

  test("rejects sweep payloads when combined base and sweep serverArgs exceed cap", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const baseServerArgs = Array.from({ length: 63 }, (_, index) => {
      return `--base-flag-${index}`;
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
        validationMode: "permissive",
        workloadId: "tuning.v0_0_1",
        engine: {
          serverArgs: baseServerArgs,
          requestParams: {},
        },
        sweep: {
          axes: {
            serverArgs: {
              extraFlags: [["--sweep-flag-a", "--sweep-flag-b"]],
            },
          },
          maxCases: 8,
          repetitions: 1,
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_SWEEP_INVALID");
    expect(payload.error.details.issues[0].code).toBe("SERVER_ARG_LIMIT_EXCEEDED");
  });

  test("rejects sweep payloads with deeply nested requestParams values", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    let deeplyNestedValue: Record<string, unknown> = {
      leaf: 1,
    };
    for (let level = 0; level < 10; level += 1) {
      deeplyNestedValue = {
        nested: deeplyNestedValue,
      };
    }

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
        workloadId: "tuning.v0_0_1",
        sweep: {
          axes: {
            requestParams: {
              max_tokens: [deeplyNestedValue],
            },
          },
          maxCases: 8,
          repetitions: 1,
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_SWEEP_INVALID");
    expect(payload.error.details.issues[0].message).toContain("nested depth exceeds");
  });

  test("rejects sweep payloads with too many axis keys at schema layer", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const requestParamAxes = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => {
        return [`axis_${index}`, [index + 1]];
      }),
    );

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
        workloadId: "tuning.v0_0_1",
        sweep: {
          axes: {
            requestParams: requestParamAxes,
          },
          maxCases: 8,
          repetitions: 1,
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_BODY_INVALID");
  });

  test("rejects sweep payloads with serverArg fragments larger than cap", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const oversizedFragment = Array.from({ length: 65 }, (_, index) => {
      return `--fragment-flag-${index}`;
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
        workloadId: "tuning.v0_0_1",
        sweep: {
          axes: {
            serverArgs: {
              oversized: [oversizedFragment],
            },
          },
          maxCases: 8,
          repetitions: 1,
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("VALIDATION_BODY_INVALID");
  });
});
