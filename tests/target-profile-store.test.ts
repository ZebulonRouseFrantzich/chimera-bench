import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TargetProfileDeleteError,
  TargetProfilePersistError,
  TargetProfileStore,
} from "../src/server/targets/target-profile-store.ts";

describe("TargetProfileStore", () => {
  test("rejects profile IDs that resolve outside storage root", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-target-store-"));

    try {
      const store = new TargetProfileStore(join(tempDirectory, "targets"));

      await expect(store.getProfile("../escape")).rejects.toBeInstanceOf(
        TargetProfilePersistError,
      );
      await expect(store.deleteProfile("../escape")).rejects.toBeInstanceOf(
        TargetProfileDeleteError,
      );
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("skips corrupt profile files when listing profiles", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-target-store-"));
    const targetsRootDir = join(tempDirectory, "targets");

    try {
      const store = new TargetProfileStore(targetsRootDir);

      await store.upsertProfile(createProfile("lab"));
      writeFileSync(join(targetsRootDir, "broken.json"), "{not-json", "utf8");

      const profiles = await store.listProfiles();
      expect(profiles.map((profile) => profile.id)).toEqual(["lab"]);
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("enforces secure permissions for default-style profile directories", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "chimera-target-store-"));
    const chimeraDirectory = join(tempDirectory, ".chimera-bench");
    const targetsRootDir = join(chimeraDirectory, "targets");

    try {
      const store = new TargetProfileStore(targetsRootDir);

      await store.upsertProfile(createProfile("lab"));

      if (process.platform !== "win32") {
        expect(statSync(chimeraDirectory).mode & 0o777).toBe(0o700);
        expect(statSync(targetsRootDir).mode & 0o777).toBe(0o700);
        expect(statSync(join(targetsRootDir, "lab.json")).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(tempDirectory, {
        recursive: true,
        force: true,
      });
    }
  });
});

function createProfile(profileId: string): {
  schemaVersion: 1;
  id: string;
  displayName: string;
  host: string;
  port: number;
  username: string;
  auth: {
    method: "ssh-agent";
  };
  remoteModelRoots: string[];
  llamaServerPath: string;
} {
  return {
    schemaVersion: 1,
    id: profileId,
    displayName: "Lab LLM box",
    host: "10.0.0.10",
    port: 22,
    username: "ubuntu",
    auth: {
      method: "ssh-agent",
    },
    remoteModelRoots: ["/models"],
    llamaServerPath: "llama-server",
  };
}
