import { describe, expect, test } from "bun:test";
import {
  buildRemoteHelpCacheKey,
  buildRemotePortReservationKey,
  createStarterSshLaunchMetadata,
  isStarterSshLaunchMetadata,
  serializeStarterSshLaunchMetadata,
} from "../src/server/engines/starter-engine-ssh.ts";
import type { TargetProfile } from "../src/server/targets/target-profile.ts";

describe("starter engine SSH helpers", () => {
  test("serializes metadata that passes runtime shape guard", () => {
    const metadata = createStarterSshLaunchMetadata({
      profile: createProfile("lab"),
      modelIdentifier: "/models/model.gguf",
      serverArgs: ["--threads", "4"],
    });

    const serialized = serializeStarterSshLaunchMetadata(metadata);
    expect(isStarterSshLaunchMetadata(serialized)).toBe(true);
  });

  test("rejects metadata when auth.method is invalid", () => {
    const metadata = createStarterSshLaunchMetadata({
      profile: createProfile("lab"),
      modelIdentifier: "/models/model.gguf",
      serverArgs: ["--threads", "4"],
    });
    const serialized = serializeStarterSshLaunchMetadata(metadata);

    const profile = serialized.profile as Record<string, unknown>;
    const auth = profile.auth as Record<string, unknown>;
    auth.method = "invalid";

    expect(isStarterSshLaunchMetadata(serialized)).toBe(false);
  });

  test("includes connection identity in remote cache keys", () => {
    const profile = createProfile("lab");
    const updatedHost = {
      ...profile,
      host: "10.0.0.11",
    };

    const firstKey = buildRemoteHelpCacheKey(profile);
    const secondKey = buildRemoteHelpCacheKey(updatedHost);

    expect(firstKey).not.toBe(secondKey);
  });

  test("includes SSH endpoint in reservation keys", () => {
    const profile = createProfile("lab");
    const updatedUser = {
      ...profile,
      username: "ops",
    };

    const firstKey = buildRemotePortReservationKey(profile);
    const secondKey = buildRemotePortReservationKey(updatedUser);

    expect(firstKey).not.toBe(secondKey);
  });
});

function createProfile(profileId: string): TargetProfile {
  return {
    schemaVersion: 1,
    id: profileId,
    displayName: "Lab",
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
