import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
      expect(cooldownResponse.headers.get("Retry-After")).not.toBeNull();

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

  test("deduplicates concurrent reload requests into one scan", async () => {
    const workloadRoot = mkdtempSync(join(tmpdir(), "chimera-workloads-reload-dedupe-"));
    const infoLines: string[] = [];

    try {
      for (let index = 0; index < 32; index += 1) {
        writeWorkloadPack(workloadRoot, `bulk-pack-${index + 1}`, {
          schemaVersion: 1,
          workloadId: `bulk${index + 1}.v1`,
          displayName: `Bulk pack ${index + 1}`,
          version: "0.1.0",
          prompts: [
            {
              promptId: `bulk${index + 1}.v1.prompt-1`,
              caseId: `bulk${index + 1}.v1.case-1`,
              messages: [
                {
                  role: "user",
                  content: "hello",
                },
              ],
            },
          ],
        });
      }

      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        workloadRoots: [workloadRoot],
        logger: {
          info(message: string): void {
            infoLines.push(message);
          },
          error(_message: string): void {},
        },
      });

      const startupResponse = await app.request("http://localhost/workloads");
      expect(startupResponse.status).toBe(200);
      infoLines.length = 0;

      const [firstReloadResponse, secondReloadResponse] = await Promise.all([
        app.request("http://localhost/workloads/reload", {
          method: "POST",
        }),
        app.request("http://localhost/workloads/reload", {
          method: "POST",
        }),
      ]);

      expect(firstReloadResponse.status).toBe(200);
      expect(secondReloadResponse.status).toBe(200);

      const reloadScanLines = infoLines.filter((line) => {
        return line.includes("event=workloads.scan trigger=reload");
      });
      expect(reloadScanLines).toHaveLength(1);
    } finally {
      rmSync(workloadRoot, {
        recursive: true,
        force: true,
      });
    }
  });

  test("logs selected and skipped sources for duplicate workload IDs", async () => {
    const workloadRoot = mkdtempSync(join(tmpdir(), "chimera-workloads-duplicates-"));
    const infoLines: string[] = [];

    try {
      writeWorkloadPack(workloadRoot, "pack-a", {
        schemaVersion: 1,
        workloadId: "duplicate.v1",
        displayName: "Duplicate A",
        version: "0.1.0",
        prompts: [
          {
            promptId: "duplicate.v1.prompt-1",
            caseId: "duplicate.v1.case-1",
            messages: [
              {
                role: "user",
                content: "from pack a",
              },
            ],
          },
        ],
      });

      writeWorkloadPack(workloadRoot, "pack-b", {
        schemaVersion: 1,
        workloadId: "duplicate.v1",
        displayName: "Duplicate B",
        version: "0.1.0",
        prompts: [
          {
            promptId: "duplicate.v1.prompt-1",
            caseId: "duplicate.v1.case-1",
            messages: [
              {
                role: "user",
                content: "from pack b",
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
        logger: {
          info(message: string): void {
            infoLines.push(message);
          },
          error(_message: string): void {},
        },
      });

      const listResponse = await app.request("http://localhost/workloads");
      expect(listResponse.status).toBe(200);

      const duplicateLog = infoLines.find((line) => {
        return line.includes("event=workloads.scan.duplicate_id_skipped");
      });
      expect(typeof duplicateLog).toBe("string");
      expect(duplicateLog).toContain("workloadId=duplicate.v1");
      expect(duplicateLog).toContain("selectedSource=");
      expect(duplicateLog).toContain("skippedSource=");
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

  test("skips packs when workload.json resolves outside the pack directory", async () => {
    const workloadRoot = mkdtempSync(join(tmpdir(), "chimera-workloads-symlink-"));
    const externalRoot = mkdtempSync(join(tmpdir(), "chimera-workloads-external-"));

    try {
      const packDir = join(workloadRoot, "symlink-pack");
      mkdirSync(packDir, {
        recursive: true,
      });

      const externalWorkloadPath = join(externalRoot, "external-workload.json");
      writeFileSync(
        externalWorkloadPath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            workloadId: "external.v1",
            displayName: "External workload",
            version: "0.1.0",
            prompts: [
              {
                promptId: "external.v1.prompt-1",
                caseId: "external.v1.case-1",
                messages: [
                  {
                    role: "user",
                    content: "hello",
                  },
                ],
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      symlinkSync(externalWorkloadPath, join(packDir, "workload.json"));

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
          (workload: { workloadId: string }) => workload.workloadId === "external.v1",
        ),
      ).toBe(false);
    } finally {
      rmSync(workloadRoot, {
        recursive: true,
        force: true,
      });
      rmSync(externalRoot, {
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
