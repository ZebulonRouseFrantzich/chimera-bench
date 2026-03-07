import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngineCatalog } from "../../src/server/engines/engine-catalog.ts";
import {
  buildApp,
  createTestPlugin,
  TEST_MODEL_IDENTIFIER,
  waitForTerminalRunStatus,
} from "./helpers.ts";

describe("run routes", () => {
  test("passes original workload messages through sweep case execution", async () => {
    const workloadRoot = mkdtempSync(join(tmpdir(), "chimera-sweep-messages-"));
    const observedMessages: Array<
      Array<{
        role: "system" | "user" | "assistant";
        content: string;
      }>
    > = [];
    const packMessages: Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }> = [
      {
        role: "system",
        content: "You are a strict formatter.",
      },
      {
        role: "user",
        content: "Draft output with heading.",
      },
      {
        role: "assistant",
        content: "# Heading\nBody",
      },
      {
        role: "user",
        content: "Revise and keep it plain text.",
      },
    ];

    try {
      writeWorkloadPack(workloadRoot, "sweep-chat-pack", {
        schemaVersion: 1,
        workloadId: "sweepchat.v1",
        displayName: "Sweep chat pack",
        version: "0.1.0",
        prompts: [
          {
            promptId: "sweepchat.v1.prompt-1",
            caseId: "sweepchat.v1.case-1",
            messages: packMessages,
          },
        ],
      });

      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        workloadRoots: [workloadRoot],
        engines: createEngineCatalog([
          createTestPlugin({
            executeCase: async (_context, caseConfig) => {
              observedMessages.push(
                caseConfig.messages.map((message) => ({
                  role: message.role,
                  content: message.content,
                })),
              );

              return {
                outputText: "ok",
              };
            },
          }),
        ]),
      });

      const createResponse = await app.request("http://localhost/runs", {
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
          workloadId: "sweepchat.v1",
          validationMode: "permissive",
          sweep: {
            axes: {
              serverArgs: {
                ctxSize: [["--ctx-size", "4096"]],
              },
              requestParams: {
                max_tokens: [128],
              },
            },
            maxCases: 4,
            repetitions: 1,
          },
        }),
      });

      expect(createResponse.status).toBe(202);
      const createPayload = await createResponse.json();
      const runId = createPayload.data?.runId;
      expect(typeof runId).toBe("string");
      if (typeof runId !== "string") {
        throw new Error("Expected run creation to return a runId.");
      }

      const status = await waitForTerminalRunStatus(app, runId);
      expect(status).toBe("completed");

      expect(observedMessages).toHaveLength(1);
      expect(observedMessages[0]).toEqual(packMessages);
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
