import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";
import { hasRestrictedEnvironmentOverrides } from "../engine-plugin.ts";
import type {
  ProcessTermination,
  SpawnAttemptInput,
  SpawnAttemptResult,
} from "./types.ts";
import { RollingTextBuffer } from "./types.ts";
import { redactSecret, toError } from "./utils.ts";

export async function spawnLlamaServerAttempt(
  input: SpawnAttemptInput,
): Promise<SpawnAttemptResult> {
  const stdoutBuffer = new RollingTextBuffer(input.dependencies.bufferedLogChars);
  const stderrBuffer = new RollingTextBuffer(input.dependencies.bufferedLogChars);

  let subprocess: ChildProcessWithoutNullStreams;

  try {
    subprocess = input.dependencies.spawnProcess(input.command, input.args, {
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildSpawnEnvironment(input.environmentOverrides),
    });
  } catch (error) {
    const startupError = toError(error);

    return {
      ok: false,
      failure: {
        reason: startupError.message,
        stdoutExcerpt: "",
        stderrExcerpt: "",
        exitCode: null,
        signal: null,
      },
    };
  }

  attachOutputBuffer(subprocess.stdout, stdoutBuffer);
  attachOutputBuffer(subprocess.stderr, stderrBuffer);
  subprocess.unref();

  const terminationPromise = createTerminationPromise(subprocess);
  const startupTermination = await waitForTermination(
    terminationPromise,
    input.dependencies.startupProbeWindowMs,
  );

  if (startupTermination === null) {
    return {
      ok: true,
      state: {
        process: subprocess,
        terminationPromise,
        stdoutBuffer,
        stderrBuffer,
      },
    };
  }

  if (startupTermination.kind === "error") {
    return {
      ok: false,
      failure: {
        reason: startupTermination.error.message,
        stdoutExcerpt: redactSecret(
          stdoutBuffer.excerpt(input.dependencies.diagnosticExcerptChars),
          input.apiKey,
        ),
        stderrExcerpt: redactSecret(
          stderrBuffer.excerpt(input.dependencies.diagnosticExcerptChars),
          input.apiKey,
        ),
        exitCode: null,
        signal: null,
      },
    };
  }

  return {
    ok: false,
    failure: {
      reason:
        startupTermination.code === null
          ? "llama-server exited during startup."
          : `llama-server exited during startup with code ${startupTermination.code}.`,
      stdoutExcerpt: redactSecret(
        stdoutBuffer.excerpt(input.dependencies.diagnosticExcerptChars),
        input.apiKey,
      ),
      stderrExcerpt: redactSecret(
        stderrBuffer.excerpt(input.dependencies.diagnosticExcerptChars),
        input.apiKey,
      ),
      exitCode: startupTermination.code,
      signal: startupTermination.signal,
    },
  };
}

export async function waitForTermination(
  terminationPromise: Promise<ProcessTermination>,
  timeoutMs: number,
): Promise<ProcessTermination | null> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      terminationPromise,
      new Promise<null>((resolvePromise) => {
        timeoutHandle = setTimeout(() => {
          resolvePromise(null);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function createTerminationPromise(
  subprocess: ChildProcessWithoutNullStreams,
): Promise<ProcessTermination> {
  return new Promise((resolvePromise) => {
    const onError = (error: Error) => {
      cleanup();
      resolvePromise({
        kind: "error",
        error,
      });
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolvePromise({
        kind: "exit",
        code,
        signal,
      });
    };

    const cleanup = () => {
      subprocess.off("error", onError);
      subprocess.off("exit", onExit);
    };

    subprocess.once("error", onError);
    subprocess.once("exit", onExit);
  });
}

function attachOutputBuffer(stream: Readable | null, outputBuffer: RollingTextBuffer): void {
  if (!stream) {
    return;
  }

  stream.setEncoding("utf8");
  stream.on("data", (chunk: string | Buffer) => {
    outputBuffer.append(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });
}

function buildSpawnEnvironment(
  environmentOverrides: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  if (!environmentOverrides) {
    return process.env;
  }

  if (hasRestrictedEnvironmentOverrides(environmentOverrides)) {
    throw new Error("llama.cpp launch config includes restricted environment overrides.");
  }

  return {
    ...process.env,
    ...environmentOverrides,
  };
}
