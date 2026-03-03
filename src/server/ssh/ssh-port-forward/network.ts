import { createServer, Socket } from "node:net";
import type { Server } from "node:net";

const PROBE_CONNECT_TIMEOUT_MS = 250;
const PROBE_STABILITY_WINDOW_MS = 150;

export async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };

      const onListening = () => {
        server.off("error", onError);
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to determine local port for SSH forwarding.");
    }

    return address.port;
  } finally {
    await closeServer(server);
  }
}

export async function probeLocalForwardReady(localPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    let stabilityTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (ready: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      if (stabilityTimer !== null) {
        clearTimeout(stabilityTimer);
      }
      cleanup();
      socket.destroy();
      resolve(ready);
    };

    const onFailure = () => {
      finish(false);
    };

    const onConnect = () => {
      stabilityTimer = setTimeout(() => {
        finish(true);
      }, PROBE_STABILITY_WINDOW_MS);
    };

    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onFailure);
      socket.off("timeout", onFailure);
      socket.off("close", onFailure);
    };

    socket.setTimeout(PROBE_CONNECT_TIMEOUT_MS);
    socket.once("connect", onConnect);
    socket.once("error", onFailure);
    socket.once("timeout", onFailure);
    socket.once("close", onFailure);
    socket.connect({
      host: "127.0.0.1",
      port: localPort,
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    try {
      server.close((error) => {
        if (!error) {
          resolve();
          return;
        }

        const errorCode = (error as NodeJS.ErrnoException).code;
        if (errorCode === "ERR_SERVER_NOT_RUNNING") {
          resolve();
          return;
        }

        reject(error);
      });
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode === "ERR_SERVER_NOT_RUNNING") {
        resolve();
        return;
      }

      reject(error);
    }
  });
}
