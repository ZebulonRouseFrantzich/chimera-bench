import { createConnection } from "node:net";
import { describe, expect, test } from "bun:test";
import { executeSshCommand } from "../src/server/ssh/ssh-exec.ts";
import {
  SshPortForwardExecutionError,
  startSshPortForward,
} from "../src/server/ssh/ssh-port-forward/index.ts";

const SSH_GATED_TEST_ENABLED = process.env.CHIMERA_SSH_TEST === "1";
const SSH_BANNER_TIMEOUT_MS = 5_000;
const SSH_BANNER_MAX_CHARS = 4 * 1024;

interface SshIntegrationConfig {
  readonly profile: {
    readonly host: string;
    readonly port: number;
    readonly username: string;
    readonly auth:
      | {
          readonly method: "ssh-agent";
        }
      | {
          readonly method: "key-path";
          readonly privateKeyPath: string;
        };
  };
}

const SSH_INTEGRATION_CONFIG = resolveSshIntegrationConfig();

describe("gated SSH integration", () => {
  if (!SSH_INTEGRATION_CONFIG) {
    test.skip("executes a remote smoke command when CHIMERA_SSH_TEST=1", () => {
      return;
    });

    test.skip("opens a loopback forward to the remote SSH daemon (self-forward smoke test)", () => {
      return;
    });

    return;
  }

  test("executes a remote smoke command when CHIMERA_SSH_TEST=1", async () => {
    const result = await executeSshCommand({
      profile: SSH_INTEGRATION_CONFIG.profile,
      remoteArgv: ["echo", "ok"],
      overallTimeoutMs: 30_000,
    });

    expect(result.stdoutExcerpt).toContain("ok");
  });

  test("opens a loopback forward to the remote SSH daemon (self-forward smoke test)", async () => {
    const abortController = new AbortController();
    const handle = await startSshPortForward({
      profile: SSH_INTEGRATION_CONFIG.profile,
      // Intentional: forward the SSH daemon port itself as a minimal tunnel-plumbing smoke test.
      remotePort: SSH_INTEGRATION_CONFIG.profile.port,
      startupTimeoutMs: 20_000,
      abortSignal: abortController.signal,
    });

    try {
      const banner = await readSshBanner(handle.localPort);
      expect(banner.startsWith("SSH-")).toBe(true);

      abortController.abort();
      await expect(handle.waitForExit()).rejects.toBeInstanceOf(
        SshPortForwardExecutionError,
      );
    } finally {
      abortController.abort();

      try {
        await handle.waitForExit();
      } catch (error) {
        if (!(error instanceof SshPortForwardExecutionError)) {
          throw error;
        }
      }
    }
  });
});

function resolveSshIntegrationConfig(): SshIntegrationConfig | null {
  if (!SSH_GATED_TEST_ENABLED) {
    return null;
  }

  const host = process.env.CHIMERA_SSH_TEST_HOST?.trim() || "127.0.0.1";
  const username = process.env.CHIMERA_SSH_TEST_USERNAME?.trim();
  if (!username) {
    throw new Error(
      "CHIMERA_SSH_TEST=1 requires CHIMERA_SSH_TEST_USERNAME to be set.",
    );
  }

  const port = parsePortFromEnv("CHIMERA_SSH_TEST_PORT", 22);
  const privateKeyPath = process.env.CHIMERA_SSH_TEST_PRIVATE_KEY_PATH?.trim();

  return {
    profile: {
      host,
      port,
      username,
      auth: privateKeyPath
        ? {
            method: "key-path",
            privateKeyPath,
          }
        : {
            method: "ssh-agent",
          },
    },
  };
}

function parsePortFromEnv(name: string, defaultPort: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return defaultPort;
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }

  const value = Number.parseInt(raw, 10);
  if (value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }

  return value;
}

async function readSshBanner(localPort: number): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({
      host: "127.0.0.1",
      port: localPort,
    });
    let buffer = "";
    let connected = false;

    const cleanup = (): void => {
      socket.off("connect", onConnect);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
      socket.off("close", onClose);
    };

    const finishError = (error: Error): void => {
      cleanup();
      socket.destroy();
      reject(error);
    };

    const onConnect = (): void => {
      connected = true;
    };

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      if (buffer.length > SSH_BANNER_MAX_CHARS) {
        finishError(
          new Error(
            `SSH banner exceeded ${SSH_BANNER_MAX_CHARS} characters on forwarded port ${localPort}.`,
          ),
        );
        return;
      }

      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }

      cleanup();
      socket.destroy();
      resolve(buffer.slice(0, newlineIndex).trim());
    };

    const onError = (error: Error): void => {
      const context = connected
        ? `Error while reading SSH banner from forwarded port ${localPort}`
        : `Failed to connect to forwarded SSH port ${localPort}`;
      finishError(new Error(`${context}: ${error.message}`));
    };

    const onTimeout = (): void => {
      finishError(
        new Error(
          connected
            ? `Timed out waiting for SSH banner data on forwarded port ${localPort}.`
            : `Timed out connecting to forwarded SSH port ${localPort}.`,
        ),
      );
    };

    const onClose = (): void => {
      if (buffer.length === 0) {
        finishError(
          new Error(
            `Forwarded SSH connection to port ${localPort} closed before banner was received.`,
          ),
        );
        return;
      }

      finishError(
        new Error(
          `Forwarded SSH connection to port ${localPort} closed before complete SSH banner line was received.`,
        ),
      );
    };

    socket.setTimeout(SSH_BANNER_TIMEOUT_MS);
    socket.once("connect", onConnect);
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.once("close", onClose);
  });
}
