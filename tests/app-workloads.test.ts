import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./helpers/app-fixture.ts";

describe("workload routes", () => {
  test("lists built-in workloads with stable vN identifiers", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const response = await app.request("http://localhost/workloads");
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.success).toBe(true);

    const workloads = payload.data?.workloads as Array<{
      workloadId: string;
      source: string;
      promptCount: number;
    }>;
    const workloadIds = workloads.map((workload) => workload.workloadId);

    expect(workloadIds).toContain("starter.v1");
    expect(workloadIds).toContain("starter.v2");
    expect(workloadIds).toContain("tuning.v1");

    const starterV2 = workloads.find((workload) => workload.workloadId === "starter.v2");
    expect(starterV2?.source).toBe("built-in");
    expect(starterV2?.promptCount).toBe(4);
  });

  test("returns prompt IDs by default and prompt bodies when requested", async () => {
    const { app } = buildApp({
      auth: {
        enabled: false,
        username: "chimera",
      },
    });

    const metadataResponse = await app.request("http://localhost/workloads/starter.v2");
    expect(metadataResponse.status).toBe(200);
    const metadataPayload = await metadataResponse.json();

    expect(metadataPayload.data.promptIds).toHaveLength(4);
    expect(metadataPayload.data.prompts).toBeUndefined();

    const promptsResponse = await app.request(
      "http://localhost/workloads/starter.v2?includePrompts=1",
    );
    expect(promptsResponse.status).toBe(200);
    const promptsPayload = await promptsResponse.json();

    expect(promptsPayload.data.promptIds).toHaveLength(4);
    expect(promptsPayload.data.prompts).toHaveLength(4);

    const followUpPrompt = promptsPayload.data.prompts.find(
      (prompt: { promptId: string }) => prompt.promptId === "starter.v2.prompt-4",
    ) as {
      messages?: Array<{ role: string; content: string }>;
    } | null;

    expect(followUpPrompt?.messages).toHaveLength(3);
    expect(followUpPrompt?.messages?.[1]?.role).toBe("assistant");
  });

  test("reloads filesystem packs and enforces reload cooldown", async () => {
    const workloadRoot = mkdtempSync(join(tmpdir(), "chimera-workloads-"));

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        workloadRoots: [workloadRoot],
      });

      const baselineResponse = await app.request("http://localhost/workloads");
      expect(baselineResponse.status).toBe(200);
      const baselinePayload = await baselineResponse.json();
      expect(
        baselinePayload.data.workloads.some(
          (workload: { workloadId: string }) => workload.workloadId === "demo.v1",
        ),
      ).toBe(false);

      writeWorkloadPack(workloadRoot, "demo-pack", {
        schemaVersion: 1,
        workloadId: "demo.v1",
        displayName: "Demo pack",
        version: "0.1.0",
        prompts: [
          {
            promptId: "demo.v1.prompt-1",
            caseId: "demo.v1.case-1",
            messages: [
              {
                role: "user",
                content: "Say hello in one sentence.",
              },
            ],
          },
        ],
      });

      const reloadResponse = await app.request("http://localhost/workloads/reload", {
        method: "POST",
      });
      expect(reloadResponse.status).toBe(200);

      const reloadedListResponse = await app.request("http://localhost/workloads");
      expect(reloadedListResponse.status).toBe(200);
      const reloadedListPayload = await reloadedListResponse.json();
      expect(
        reloadedListPayload.data.workloads.some(
          (workload: { workloadId: string; source: string }) =>
            workload.workloadId === "demo.v1" && workload.source === "filesystem",
        ),
      ).toBe(true);

      const cooldownResponse = await app.request("http://localhost/workloads/reload", {
        method: "POST",
      });
      expect(cooldownResponse.status).toBe(429);

      const cooldownPayload = await cooldownResponse.json();
      expect(cooldownPayload.error.code).toBe("WORKLOADS_RELOAD_COOLDOWN");
      expect(typeof cooldownPayload.error.details.retryAfterMs).toBe("number");
      expect(cooldownPayload.error.details.retryAfterMs).toBeGreaterThan(0);
    } finally {
      rmSync(workloadRoot, {
        recursive: true,
        force: true,
      });
    }
  });

  test("skips filesystem packs with traversal context paths", async () => {
    const workloadRoot = mkdtempSync(join(tmpdir(), "chimera-workloads-invalid-"));

    try {
      writeWorkloadPack(workloadRoot, "invalid-pack", {
        schemaVersion: 1,
        workloadId: "invalid.v1",
        displayName: "Invalid pack",
        version: "0.1.0",
        prompts: [
          {
            promptId: "invalid.v1.prompt-1",
            caseId: "invalid.v1.case-1",
            contextFiles: ["../escape.txt"],
            messages: [
              {
                role: "user",
                content: "hello",
              },
            ],
          },
        ],
      });

      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        workloadRoots: [workloadRoot],
      });

      const listResponse = await app.request("http://localhost/workloads");
      expect(listResponse.status).toBe(200);
      const listPayload = await listResponse.json();

      expect(
        listPayload.data.workloads.some(
          (workload: { workloadId: string }) => workload.workloadId === "invalid.v1",
        ),
      ).toBe(false);
    } finally {
      rmSync(workloadRoot, {
        recursive: true,
        force: true,
      });
    }
  });

  test("rejects includePrompts responses above the 2 MiB ceiling", async () => {
    const workloadRoot = mkdtempSync(join(tmpdir(), "chimera-workloads-large-"));

    try {
      const largePromptText = "x".repeat(10_000);
      writeWorkloadPack(workloadRoot, "large-pack", {
        schemaVersion: 1,
        workloadId: "large.v1",
        displayName: "Large workload",
        version: "0.1.0",
        prompts: Array.from({ length: 220 }, (_value, index) => {
          return {
            promptId: `large.v1.prompt-${index + 1}`,
            caseId: `large.v1.case-${index + 1}`,
            messages: [
              {
                role: "user",
                content: largePromptText,
              },
            ],
          };
        }),
      });

      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        workloadRoots: [workloadRoot],
      });

      const response = await app.request("http://localhost/workloads/large.v1?includePrompts=1");
      expect(response.status).toBe(413);

      const payload = await response.json();
      expect(payload.error.code).toBe("RESPONSE_TOO_LARGE");
    } finally {
      rmSync(workloadRoot, {
        recursive: true,
        force: true,
      });
    }
  });
});

function writeWorkloadPack(
  workloadRoot: string,
  directoryName: string,
  workloadPack: unknown,
): void {
  const packDir = join(workloadRoot, directoryName);
  mkdirSync(packDir, {
    recursive: true,
  });

  writeFileSync(
    join(packDir, "workload.json"),
    `${JSON.stringify(workloadPack, null, 2)}\n`,
    "utf8",
  );
}
