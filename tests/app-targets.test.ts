import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./helpers/app-fixture.ts";

describe("target routes", () => {
  test("creates, lists, fetches, and deletes target profiles", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-targets-"));
    const targetsRootDir = join(tempDirectory, "targets");

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        targetProfilesRootDir: targetsRootDir,
      });

      const createResponse = await app.request("http://localhost/targets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(createTargetProfilePayload()),
      });
      expect(createResponse.status).toBe(201);

      const createPayload = await createResponse.json();
      expect(createPayload.success).toBe(true);
      expect(createPayload.data.profile.id).toBe("lab");
      expect(createPayload.data.profile.port).toBe(22);
      expect(createPayload.data.profile.auth.method).toBe("ssh-agent");
      expect(createPayload.data.profile.llamaServerPath).toBe("llama-server");

      const listResponse = await app.request("http://localhost/targets");
      expect(listResponse.status).toBe(200);

      const listPayload = await listResponse.json();
      expect(listPayload.success).toBe(true);
      expect(listPayload.data.profiles).toHaveLength(1);
      expect(listPayload.data.profiles[0].id).toBe("lab");

      const getResponse = await app.request("http://localhost/targets/lab");
      expect(getResponse.status).toBe(200);

      const getPayload = await getResponse.json();
      expect(getPayload.success).toBe(true);
      expect(getPayload.data.profile.remoteModelRoots).toEqual(["/models"]);

      const profilePath = join(targetsRootDir, "lab.json");
      const storedProfile = JSON.parse(readFileSync(profilePath, "utf8")) as {
        auth?: {
          method?: string;
          privateKeyPath?: string;
        };
      };
      expect(storedProfile.auth).toEqual({
        method: "ssh-agent",
      });

      if (process.platform !== "win32") {
        expect(statSync(targetsRootDir).mode & 0o777).toBe(0o700);
        expect(statSync(profilePath).mode & 0o777).toBe(0o600);
      }

      const deleteResponse = await app.request("http://localhost/targets/lab", {
        method: "DELETE",
      });
      expect(deleteResponse.status).toBe(200);

      const deletePayload = await deleteResponse.json();
      expect(deletePayload.success).toBe(true);
      expect(deletePayload.data.id).toBe("lab");

      const missingResponse = await app.request("http://localhost/targets/lab");
      expect(missingResponse.status).toBe(404);

      const missingPayload = await missingResponse.json();
      expect(missingPayload.error.code).toBe("TARGET_PROFILE_NOT_FOUND");
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("returns 200 when updating an existing target profile", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-targets-"));
    const targetsRootDir = join(tempDirectory, "targets");

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        targetProfilesRootDir: targetsRootDir,
      });

      const createResponse = await app.request("http://localhost/targets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(createTargetProfilePayload()),
      });
      expect(createResponse.status).toBe(201);

      const updateResponse = await app.request("http://localhost/targets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          createTargetProfilePayload({
            displayName: "Lab LLM box (updated)",
            port: 2222,
          }),
        ),
      });
      expect(updateResponse.status).toBe(200);

      const updatePayload = await updateResponse.json();
      expect(updatePayload.data.profile.displayName).toBe("Lab LLM box (updated)");
      expect(updatePayload.data.profile.port).toBe(2222);
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("rejects invalid target profile payloads", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-targets-"));
    const targetsRootDir = join(tempDirectory, "targets");

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        targetProfilesRootDir: targetsRootDir,
      });

      const missingRootsResponse = await app.request("http://localhost/targets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          schemaVersion: 1,
          id: "lab",
          displayName: "Lab",
          host: "10.0.0.10",
          username: "ubuntu",
        }),
      });

      expect(missingRootsResponse.status).toBe(400);
      const missingRootsPayload = await missingRootsResponse.json();
      expect(missingRootsPayload.error.code).toBe("VALIDATION_TARGET_PROFILE_INVALID");

      const invalidPortResponse = await app.request("http://localhost/targets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          createTargetProfilePayload({
            port: 99999,
          }),
        ),
      });

      expect(invalidPortResponse.status).toBe(400);
      const invalidPortPayload = await invalidPortResponse.json();
      expect(invalidPortPayload.error.code).toBe("VALIDATION_TARGET_PROFILE_INVALID");

      const invalidHostResponse = await app.request("http://localhost/targets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          createTargetProfilePayload({
            host: "invalid host",
          }),
        ),
      });

      expect(invalidHostResponse.status).toBe(400);
      const invalidHostPayload = await invalidHostResponse.json();
      expect(invalidHostPayload.error.code).toBe("VALIDATION_TARGET_PROFILE_INVALID");

      const invalidUsernameResponse = await app.request("http://localhost/targets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          createTargetProfilePayload({
            username: "ubuntu;rm",
          }),
        ),
      });

      expect(invalidUsernameResponse.status).toBe(400);
      const invalidUsernamePayload = await invalidUsernameResponse.json();
      expect(invalidUsernamePayload.error.code).toBe("VALIDATION_TARGET_PROFILE_INVALID");

      const oversizedIdResponse = await app.request("http://localhost/targets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          createTargetProfilePayload({
            id: `profile-${"a".repeat(80)}`,
          }),
        ),
      });

      expect(oversizedIdResponse.status).toBe(400);
      const oversizedIdPayload = await oversizedIdResponse.json();
      expect(oversizedIdPayload.error.code).toBe("VALIDATION_TARGET_PROFILE_INVALID");

      const tooManyRootsResponse = await app.request("http://localhost/targets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          createTargetProfilePayload({
            remoteModelRoots: Array.from(
              {
                length: 65,
              },
              (_, index) => `/models-${index}`,
            ),
          }),
        ),
      });

      expect(tooManyRootsResponse.status).toBe(400);
      const tooManyRootsPayload = await tooManyRootsResponse.json();
      expect(tooManyRootsPayload.error.code).toBe("VALIDATION_TARGET_PROFILE_INVALID");

      const nullBytePathResponse = await app.request("http://localhost/targets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          createTargetProfilePayload({
            remoteModelRoots: ["/models\u0000unsafe"],
          }),
        ),
      });

      expect(nullBytePathResponse.status).toBe(400);
      const nullBytePathPayload = await nullBytePathResponse.json();
      expect(nullBytePathPayload.error.code).toBe("VALIDATION_TARGET_PROFILE_INVALID");
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("rejects key-path auth when private key path is not readable", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-targets-"));
    const targetsRootDir = join(tempDirectory, "targets");

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        targetProfilesRootDir: targetsRootDir,
      });

      const response = await app.request("http://localhost/targets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          createTargetProfilePayload({
            auth: {
              method: "key-path",
              privateKeyPath: join(tempDirectory, "missing-key"),
            },
          }),
        ),
      });

      expect(response.status).toBe(400);
      const payload = await response.json();
      expect(payload.error.code).toBe("VALIDATION_TARGET_PROFILE_INVALID");
      expect(payload.error.details.issues[0].path).toBe("auth.privateKeyPath");
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("returns not found and invalid id errors for profile routes", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-targets-"));
    const targetsRootDir = join(tempDirectory, "targets");

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        targetProfilesRootDir: targetsRootDir,
      });

      const missingGetResponse = await app.request(
        "http://localhost/targets/does-not-exist",
      );
      expect(missingGetResponse.status).toBe(404);
      const missingGetPayload = await missingGetResponse.json();
      expect(missingGetPayload.error.code).toBe("TARGET_PROFILE_NOT_FOUND");

      const missingDeleteResponse = await app.request(
        "http://localhost/targets/does-not-exist",
        {
          method: "DELETE",
        },
      );
      expect(missingDeleteResponse.status).toBe(404);
      const missingDeletePayload = await missingDeleteResponse.json();
      expect(missingDeletePayload.error.code).toBe("TARGET_PROFILE_NOT_FOUND");

      const invalidIdResponse = await app.request("http://localhost/targets/Invalid_ID");
      expect(invalidIdResponse.status).toBe(400);
      const invalidIdPayload = await invalidIdResponse.json();
      expect(invalidIdPayload.error.code).toBe("VALIDATION_TARGET_PROFILE_INVALID");
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("logs target profile persistence errors", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-targets-"));
    const blockedRoot = join(tempDirectory, "blocked-root");
    writeFileSync(blockedRoot, "blocked");
    const logLines: string[] = [];

    try {
      const { app } = buildApp({
        auth: {
          enabled: false,
          username: "chimera",
        },
        targetProfilesRootDir: join(blockedRoot, "targets"),
        logger: createTestLogger(logLines),
      });

      const response = await app.request("http://localhost/targets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(createTargetProfilePayload()),
      });

      expect(response.status).toBe(500);
      const payload = await response.json();
      expect(payload.error.code).toBe("TARGET_PROFILE_PERSIST_FAILED");
      expect(
        logLines.some((line) => {
          return (
            line.includes("targetProfileOperation=upsert") &&
            line.includes("reason=")
          );
        }),
      ).toBe(true);
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });
});

function createTargetProfilePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "lab",
    displayName: "Lab LLM box",
    host: "10.0.0.10",
    username: "ubuntu",
    remoteModelRoots: ["/models"],
    ...overrides,
  };
}

function createTestLogger(logLines: string[]): {
  info(message: string): void;
  error(message: string): void;
} {
  return {
    info(message: string): void {
      logLines.push(message);
    },
    error(message: string): void {
      logLines.push(message);
    },
  };
}
