import { describe, expect, test } from "bun:test";
import { TargetProfileSchema } from "../src/server/targets/target-profile.ts";

describe("TargetProfileSchema", () => {
  test("accepts a minimal valid profile and applies defaults", () => {
    const parsed = TargetProfileSchema.safeParse({
      schemaVersion: 1,
      id: "lab",
      displayName: "Lab LLM box",
      host: "10.0.0.10",
      username: "ubuntu",
      remoteModelRoots: ["/models"],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error("Expected target profile parse to succeed.");
    }

    expect(parsed.data.port).toBe(22);
    expect(parsed.data.auth.method).toBe("ssh-agent");
    expect(parsed.data.llamaServerPath).toBe("llama-server");
  });

  test("rejects invalid hostnames and usernames", () => {
    const invalidHost = TargetProfileSchema.safeParse({
      schemaVersion: 1,
      id: "lab",
      displayName: "Lab LLM box",
      host: "host with spaces",
      username: "ubuntu",
      remoteModelRoots: ["/models"],
    });

    expect(invalidHost.success).toBe(false);

    const invalidUsername = TargetProfileSchema.safeParse({
      schemaVersion: 1,
      id: "lab",
      displayName: "Lab LLM box",
      host: "10.0.0.10",
      username: "ubuntu;rm",
      remoteModelRoots: ["/models"],
    });

    expect(invalidUsername.success).toBe(false);
  });

  test("rejects oversized profile fields", () => {
    const oversized = TargetProfileSchema.safeParse({
      schemaVersion: 1,
      id: `profile-${"a".repeat(80)}`,
      displayName: "Lab LLM box",
      host: "10.0.0.10",
      username: "ubuntu",
      remoteModelRoots: ["/models"],
    });

    expect(oversized.success).toBe(false);
  });

  test("rejects too many remote model roots", () => {
    const roots = Array.from({ length: 65 }, (_, index) => `/models-${index}`);
    const parsed = TargetProfileSchema.safeParse({
      schemaVersion: 1,
      id: "lab",
      displayName: "Lab LLM box",
      host: "10.0.0.10",
      username: "ubuntu",
      remoteModelRoots: roots,
    });

    expect(parsed.success).toBe(false);
  });

  test("rejects control characters in absolute paths", () => {
    const parsed = TargetProfileSchema.safeParse({
      schemaVersion: 1,
      id: "lab",
      displayName: "Lab LLM box",
      host: "10.0.0.10",
      username: "ubuntu",
      auth: {
        method: "key-path",
        privateKeyPath: "/home/user/.ssh/id_rsa\u0000suffix",
      },
      remoteModelRoots: ["/models\u0000unsafe"],
    });

    expect(parsed.success).toBe(false);
  });
});
