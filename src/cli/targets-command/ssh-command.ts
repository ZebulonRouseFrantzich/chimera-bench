import type {
  SshCommandSuccess,
} from "../../server/ssh/ssh-exec.ts";
import type { TargetProfile } from "../../server/targets/target-profile.ts";
import type { TargetsCommandDependencies } from "./types.ts";

export async function runSshCommandWithCancellation(
  request: {
    profile: Pick<TargetProfile, "host" | "port" | "username" | "auth">;
    remoteArgv: string[];
    overallTimeoutMs: number;
    onStdoutChunk?: (chunk: string) => void;
    onStderrChunk?: (chunk: string) => void;
  },
  dependencies: TargetsCommandDependencies,
): Promise<SshCommandSuccess> {
  const abortController = new AbortController();
  let cancelledBySignal = false;

  const cleanupSignalHandlers = () => {
    dependencies.removeSignalListener("SIGINT", onSigint);
    dependencies.removeSignalListener("SIGTERM", onSigterm);
  };

  const shutdown = (signal: "SIGINT" | "SIGTERM") => {
    if (cancelledBySignal) {
      return;
    }

    cancelledBySignal = true;
    cleanupSignalHandlers();
    dependencies.printError(`[chimera-bench] received ${signal}, cancelling SSH command...`);
    abortController.abort();
  };

  const onSigint = () => shutdown("SIGINT");
  const onSigterm = () => shutdown("SIGTERM");

  dependencies.addSignalListener("SIGINT", onSigint);
  dependencies.addSignalListener("SIGTERM", onSigterm);

  try {
    return await dependencies.executeSsh({
      profile: request.profile,
      remoteArgv: request.remoteArgv,
      overallTimeoutMs: request.overallTimeoutMs,
      abortSignal: abortController.signal,
      ...(request.onStdoutChunk
        ? {
            onStdoutChunk: request.onStdoutChunk,
          }
        : {}),
      ...(request.onStderrChunk
        ? {
            onStderrChunk: request.onStderrChunk,
          }
        : {}),
    });
  } finally {
    cleanupSignalHandlers();
  }
}
