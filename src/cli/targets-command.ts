import { sanitizeControlCharacters } from "../server/http/sanitize.ts";
import {
  type TargetProfile,
  TargetProfileIdSchema,
} from "../server/targets/target-profile.ts";
import {
  TargetProfileDeleteError,
  TargetProfileNotFoundError,
  TargetProfilePersistError,
  TargetProfileStore,
} from "../server/targets/target-profile-store.ts";
import {
  buildSshCommandArgv,
  executeSshCommand,
  SshCommandExecutionError,
  SshCommandValidationError,
  type SshCommandSuccess,
} from "../server/ssh/ssh-exec.ts";
import {
  SshPortForwardExecutionError,
  SshPortForwardValidationError,
  startSshPortForward,
} from "../server/ssh/ssh-port-forward.ts";
import { toError } from "../server/error-utils.ts";

const TARGETS_EXEC_ENABLEMENT_ENV_KEY = "CHIMERA_ENABLE_TARGETS_EXEC";
const CHECK_REMOTE_ARGV = ["echo", "ok"];
const DEFAULT_TARGETS_CHECK_TIMEOUT_MS = 30_000;
const DEFAULT_TARGETS_EXEC_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_TARGETS_FORWARD_STARTUP_TIMEOUT_MS = 15_000;

interface TargetsCommandDependencies {
  readonly targetProfiles: TargetProfileStore;
  readonly executeSsh: typeof executeSshCommand;
  readonly buildSshArgv: typeof buildSshCommandArgv;
  readonly startPortForward: typeof startSshPortForward;
  readonly addSignalListener: (
    signal: "SIGINT" | "SIGTERM",
    listener: () => void,
  ) => void;
  readonly removeSignalListener: (
    signal: "SIGINT" | "SIGTERM",
    listener: () => void,
  ) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly print: (message: string) => void;
  readonly printError: (message: string) => void;
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
}

export class TargetsCommandUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetsCommandUsageError";
  }
}

class TargetsCommandRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetsCommandRuntimeError";
  }
}

interface ParsedExecOptions {
  readonly profileId: string;
  readonly dryRun: boolean;
  readonly remoteArgv: string[];
}

interface ParsedForwardOptions {
  readonly profileId: string;
  readonly remotePort: number;
  readonly printLocalPortOnly: boolean;
}

export function getTargetsCommandHelp(): string {
  return [
    "Usage: chimera-bench targets <subcommand> [options]",
    "",
    "Subcommands:",
    "  list                                List stored SSH target profiles",
    "  show <profileId>                    Print one stored target profile JSON",
    "  rm <profileId>                      Remove one stored target profile",
    "  check <profileId>                   Run a remote SSH smoke check (echo ok)",
    "  forward <profileId> --remote-port <port> [--print-local-port]",
    "                                      Open SSH local port-forward and print local port",
    "  exec <profileId> [--dry-run] -- <argv...>",
    "                                      Run explicit remote argv over SSH",
    "",
    "Options:",
    "  -h, --help                          Show this help",
    "",
    "Security:",
    "  `targets exec` only runs when CHIMERA_ENABLE_TARGETS_EXEC=1 is set.",
    "  `--dry-run` always works and prints the constructed ssh argv JSON.",
    "  `targets forward` is intentionally ungated; it only opens a loopback-to-loopback tunnel.",
    "  `--print-local-port` prints only the local port to stdout for scripts.",
    "",
    "Remote shell requirement:",
    "  The remote SSH user must use a POSIX-compatible login shell (for example bash or dash).",
  ].join("\n");
}

export async function runTargetsCommand(
  args: string[],
  overrides: Partial<TargetsCommandDependencies> = {},
): Promise<void> {
  const dependencies = createDependencies(overrides);
  const normalizedArgs = stripLeadingNoOpSeparators(args);

  if (isHelpToken(normalizedArgs[0])) {
    dependencies.print(getTargetsCommandHelp());
    return;
  }

  const [subcommand, ...subcommandArgs] = normalizedArgs;
  if (!subcommand) {
    throw new TargetsCommandUsageError("targets requires a subcommand.");
  }

  switch (subcommand) {
    case "list":
      await runListCommand(subcommandArgs, dependencies);
      return;
    case "show":
      await runShowCommand(subcommandArgs, dependencies);
      return;
    case "rm":
      await runRemoveCommand(subcommandArgs, dependencies);
      return;
    case "check":
      await runCheckCommand(subcommandArgs, dependencies);
      return;
    case "forward":
      await runForwardCommand(subcommandArgs, dependencies);
      return;
    case "exec":
      await runExecCommand(subcommandArgs, dependencies);
      return;
    default:
      throw new TargetsCommandUsageError(`Unknown targets subcommand: ${subcommand}`);
  }
}

async function runListCommand(
  args: string[],
  dependencies: TargetsCommandDependencies,
): Promise<void> {
  const normalizedArgs = stripNoOpSeparators(args);
  if (containsHelpToken(normalizedArgs)) {
    dependencies.print(getTargetsCommandHelp());
    return;
  }

  assertNoExtraArgs(normalizedArgs, "targets list");

  let profiles: TargetProfile[];
  try {
    profiles = await dependencies.targetProfiles.listProfiles();
  } catch (error) {
    throw wrapTargetStoreError("Failed to list target profiles.", error);
  }

  if (profiles.length === 0) {
    dependencies.print("No target profiles found.");
    return;
  }

  for (const profile of profiles) {
    dependencies.print(
      `${profile.id}\t${profile.username}@${profile.host}:${profile.port}\t${sanitizeControlCharacters(profile.displayName)}`,
    );
  }
}

async function runShowCommand(
  args: string[],
  dependencies: TargetsCommandDependencies,
): Promise<void> {
  const normalizedArgs = stripNoOpSeparators(args);
  if (containsHelpToken(normalizedArgs)) {
    dependencies.print(getTargetsCommandHelp());
    return;
  }

  const profileId = parseSingleProfileId(normalizedArgs, "targets show");
  const profile = await readProfile(profileId, dependencies.targetProfiles);
  dependencies.print(`${JSON.stringify(profile, null, 2)}`);
}

async function runRemoveCommand(
  args: string[],
  dependencies: TargetsCommandDependencies,
): Promise<void> {
  const normalizedArgs = stripNoOpSeparators(args);
  if (containsHelpToken(normalizedArgs)) {
    dependencies.print(getTargetsCommandHelp());
    return;
  }

  const profileId = parseSingleProfileId(normalizedArgs, "targets rm");

  try {
    await dependencies.targetProfiles.deleteProfile(profileId);
  } catch (error) {
    if (error instanceof TargetProfileNotFoundError) {
      throw new TargetsCommandRuntimeError(
        `Target profile '${sanitizeControlCharacters(profileId)}' was not found.`,
      );
    }

    throw wrapTargetStoreError(
      `Failed to remove target profile '${sanitizeControlCharacters(profileId)}'.`,
      error,
    );
  }

  dependencies.print(`Removed target profile '${profileId}'.`);
}

async function runCheckCommand(
  args: string[],
  dependencies: TargetsCommandDependencies,
): Promise<void> {
  const normalizedArgs = stripNoOpSeparators(args);
  if (containsHelpToken(normalizedArgs)) {
    dependencies.print(getTargetsCommandHelp());
    return;
  }

  const profileId = parseSingleProfileId(normalizedArgs, "targets check");
  const profile = await readProfile(profileId, dependencies.targetProfiles);

  try {
    await runSshCommandWithCancellation(
      {
        profile,
        remoteArgv: CHECK_REMOTE_ARGV,
        overallTimeoutMs: DEFAULT_TARGETS_CHECK_TIMEOUT_MS,
      },
      dependencies,
    );
  } catch (error) {
    throw wrapSshCommandError(
      `Target check failed for profile '${sanitizeControlCharacters(profileId)}'.`,
      error,
    );
  }

  dependencies.print(`Target '${profileId}' check succeeded.`);
}

async function runForwardCommand(
  args: string[],
  dependencies: TargetsCommandDependencies,
): Promise<void> {
  const normalizedArgs = stripNoOpSeparators(args);
  if (containsHelpToken(normalizedArgs)) {
    dependencies.print(getTargetsCommandHelp());
    return;
  }

  const parsed = parseForwardOptions(normalizedArgs);
  const profile = await readProfile(parsed.profileId, dependencies.targetProfiles);

  const abortController = new AbortController();
  let cancelledBySignal = false;
  let shutdownCompletePrinted = false;
  let signalHandlersRegistered = false;

  const printShutdownComplete = () => {
    if (shutdownCompletePrinted) {
      return;
    }

    shutdownCompletePrinted = true;
    dependencies.printError("[chimera-bench] shutdown complete.");
  };

  const cleanupSignalHandlers = () => {
    if (!signalHandlersRegistered) {
      return;
    }

    signalHandlersRegistered = false;
    dependencies.removeSignalListener("SIGINT", onSigint);
    dependencies.removeSignalListener("SIGTERM", onSigterm);
  };

  const shutdown = (signal: "SIGINT" | "SIGTERM") => {
    if (cancelledBySignal) {
      return;
    }

    cancelledBySignal = true;
    cleanupSignalHandlers();
    dependencies.printError(`[chimera-bench] received ${signal}, shutting down...`);
    abortController.abort();
  };

  const onSigint = () => shutdown("SIGINT");
  const onSigterm = () => shutdown("SIGTERM");

  try {
    dependencies.addSignalListener("SIGINT", onSigint);
    dependencies.addSignalListener("SIGTERM", onSigterm);
    signalHandlersRegistered = true;

    const forwardHandle = await dependencies.startPortForward({
      profile,
      remotePort: parsed.remotePort,
      startupTimeoutMs: DEFAULT_TARGETS_FORWARD_STARTUP_TIMEOUT_MS,
      abortSignal: abortController.signal,
    });

    const statusLine =
      `Forward ready: 127.0.0.1:${forwardHandle.localPort} -> 127.0.0.1:${parsed.remotePort}`;
    if (parsed.printLocalPortOnly) {
      dependencies.print(String(forwardHandle.localPort));
      dependencies.printError(statusLine);
    } else {
      dependencies.print(statusLine);
    }

    await forwardHandle.waitForExit();

    if (!cancelledBySignal) {
      throw new TargetsCommandRuntimeError(
        `Target forward for profile '${sanitizeControlCharacters(parsed.profileId)}' stopped unexpectedly.`,
      );
    }

    printShutdownComplete();
  } catch (error) {
    if (cancelledBySignal) {
      printShutdownComplete();
      return;
    }

    throw wrapSshPortForwardError(
      `targets forward failed for profile '${sanitizeControlCharacters(parsed.profileId)}'.`,
      error,
    );
  } finally {
    cleanupSignalHandlers();
  }
}

async function runExecCommand(
  args: string[],
  dependencies: TargetsCommandDependencies,
): Promise<void> {
  const normalizedArgs = stripLeadingNoOpSeparators(args);
  if (containsHelpTokenBeforeExecSeparator(normalizedArgs)) {
    dependencies.print(getTargetsCommandHelp());
    return;
  }

  const parsed = parseExecOptions(normalizedArgs);
  if (!parsed.dryRun && dependencies.env[TARGETS_EXEC_ENABLEMENT_ENV_KEY] !== "1") {
    throw new TargetsCommandUsageError(
      "targets exec is disabled by default. Set CHIMERA_ENABLE_TARGETS_EXEC=1 to enable execution, or use --dry-run.",
    );
  }

  const profile = await readProfile(parsed.profileId, dependencies.targetProfiles);
  const sshArgv = dependencies.buildSshArgv({
    profile,
    remoteArgv: parsed.remoteArgv,
  });

  if (parsed.dryRun) {
    dependencies.print(JSON.stringify(sshArgv));
    return;
  }

  dependencies.printError(
    "[chimera-bench] warning: targets exec runs arbitrary remote commands as the configured SSH user.",
  );

  try {
    await runSshCommandWithCancellation(
      {
        profile,
        remoteArgv: parsed.remoteArgv,
        overallTimeoutMs: DEFAULT_TARGETS_EXEC_TIMEOUT_MS,
        onStdoutChunk: dependencies.writeStdout,
        onStderrChunk: dependencies.writeStderr,
      },
      dependencies,
    );
  } catch (error) {
    throw wrapSshCommandError(
      `targets exec failed for profile '${sanitizeControlCharacters(parsed.profileId)}'.`,
      error,
    );
  }
}

function parseSingleProfileId(args: string[], commandName: string): string {
  const [profileId, ...extra] = args;
  if (!profileId) {
    throw new TargetsCommandUsageError(`${commandName} requires <profileId>.`);
  }

  if (extra.length > 0) {
    throw new TargetsCommandUsageError(`${commandName} does not accept extra arguments.`);
  }

  const parsed = TargetProfileIdSchema.safeParse(profileId.trim());
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message ?? "profileId is invalid.";
    throw new TargetsCommandUsageError(issue);
  }

  return parsed.data;
}

async function readProfile(
  profileId: string,
  targetProfiles: TargetProfileStore,
): Promise<TargetProfile> {
  try {
    return await targetProfiles.getProfile(profileId);
  } catch (error) {
    if (error instanceof TargetProfileNotFoundError) {
      throw new TargetsCommandRuntimeError(
        `Target profile '${sanitizeControlCharacters(profileId)}' was not found.`,
      );
    }

    throw wrapTargetStoreError(
      `Failed to load target profile '${sanitizeControlCharacters(profileId)}'.`,
      error,
    );
  }
}

function parseForwardOptions(args: string[]): ParsedForwardOptions {
  const [rawProfileId, ...rest] = args;
  if (!rawProfileId) {
    throw new TargetsCommandUsageError("targets forward requires <profileId>.");
  }

  const profileId = parseSingleProfileId([rawProfileId], "targets forward");
  let remotePort: number | null = null;
  let printLocalPortOnly = false;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (token === "--remote-port") {
      if (remotePort !== null) {
        throw new TargetsCommandUsageError(
          "targets forward accepts --remote-port at most once.",
        );
      }

      remotePort = parsePortOption(rest[index + 1], "--remote-port");
      index += 1;
      continue;
    }

    if (token?.startsWith("--remote-port=")) {
      if (remotePort !== null) {
        throw new TargetsCommandUsageError(
          "targets forward accepts --remote-port at most once.",
        );
      }

      remotePort = parsePortOption(token.slice("--remote-port=".length), "--remote-port");
      continue;
    }

    if (token === "--print-local-port") {
      if (printLocalPortOnly) {
        throw new TargetsCommandUsageError(
          "targets forward accepts --print-local-port at most once.",
        );
      }

      printLocalPortOnly = true;
      continue;
    }

    throw new TargetsCommandUsageError(
      `Unknown option for targets forward: ${sanitizeControlCharacters(token ?? "")}`,
    );
  }

  if (remotePort === null) {
    throw new TargetsCommandUsageError(
      "targets forward requires --remote-port <port>.",
    );
  }

  return {
    profileId,
    remotePort,
    printLocalPortOnly,
  };
}

function parsePortOption(value: string | undefined, optionName: string): number {
  if (value === undefined) {
    throw new TargetsCommandUsageError(`${optionName} requires a value.`);
  }

  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new TargetsCommandUsageError(
      `${optionName} must be an integer between 1 and 65535.`,
    );
  }

  const parsed = Number.parseInt(normalized, 10);
  if (parsed < 1 || parsed > 65535) {
    throw new TargetsCommandUsageError(
      `${optionName} must be an integer between 1 and 65535.`,
    );
  }

  return parsed;
}

function parseExecOptions(args: string[]): ParsedExecOptions {
  const [rawProfileId, ...rest] = args;
  if (!rawProfileId) {
    throw new TargetsCommandUsageError("targets exec requires <profileId>.");
  }

  const profileId = parseSingleProfileId([rawProfileId], "targets exec");

  let dryRun = false;
  let commandSeparatorIndex = -1;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (token === "--") {
      commandSeparatorIndex = index;
      break;
    }

    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }

    throw new TargetsCommandUsageError(
      `Unknown option for targets exec: ${sanitizeControlCharacters(token ?? "")}`,
    );
  }

  if (commandSeparatorIndex < 0) {
    throw new TargetsCommandUsageError(
      "targets exec requires `-- <argv...>` to separate command arguments.",
    );
  }

  const remoteArgv = rest.slice(commandSeparatorIndex + 1);
  if (remoteArgv.length === 0) {
    throw new TargetsCommandUsageError("targets exec requires at least one remote argv token.");
  }

  return {
    profileId,
    dryRun,
    remoteArgv,
  };
}

async function runSshCommandWithCancellation(
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
    dependencies.printError(
      `[chimera-bench] received ${signal}, cancelling SSH command...`,
    );
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

function wrapSshCommandError(prefix: string, error: unknown): TargetsCommandRuntimeError {
  if (error instanceof SshCommandValidationError) {
    return new TargetsCommandRuntimeError(
      `${prefix} ${sanitizeControlCharacters(error.message)}`,
    );
  }

  if (error instanceof SshCommandExecutionError) {
    const details: string[] = [];
    if (error.details.stderrExcerpt.length > 0) {
      details.push(
        `stderr excerpt: ${sanitizeControlCharacters(error.details.stderrExcerpt)}`,
      );
    }

    if (error.details.stdoutExcerpt.length > 0) {
      details.push(
        `stdout excerpt: ${sanitizeControlCharacters(error.details.stdoutExcerpt)}`,
      );
    }

    const suffix = details.length > 0 ? ` ${details.join(" ")}` : "";
    return new TargetsCommandRuntimeError(
      `${prefix} ${sanitizeControlCharacters(error.message)}${suffix}`,
    );
  }

  return new TargetsCommandRuntimeError(
    `${prefix} ${sanitizeControlCharacters(toError(error).message)}`,
  );
}

function wrapSshPortForwardError(
  prefix: string,
  error: unknown,
): TargetsCommandRuntimeError {
  if (error instanceof SshPortForwardValidationError) {
    return new TargetsCommandRuntimeError(
      `${prefix} ${sanitizeControlCharacters(error.message)}`,
    );
  }

  if (error instanceof SshPortForwardExecutionError) {
    const details: string[] = [];
    if (error.details.stderrExcerpt.length > 0) {
      details.push(
        `stderr excerpt: ${sanitizeControlCharacters(error.details.stderrExcerpt)}`,
      );
    }

    if (error.details.stdoutExcerpt.length > 0) {
      details.push(
        `stdout excerpt: ${sanitizeControlCharacters(error.details.stdoutExcerpt)}`,
      );
    }

    const suffix = details.length > 0 ? ` ${details.join(" ")}` : "";
    return new TargetsCommandRuntimeError(
      `${prefix} ${sanitizeControlCharacters(error.message)}${suffix}`,
    );
  }

  return new TargetsCommandRuntimeError(
    `${prefix} ${sanitizeControlCharacters(toError(error).message)}`,
  );
}

function wrapTargetStoreError(prefix: string, error: unknown): TargetsCommandRuntimeError {
  if (
    error instanceof TargetProfilePersistError ||
    error instanceof TargetProfileDeleteError
  ) {
    return new TargetsCommandRuntimeError(
      `${prefix} ${sanitizeControlCharacters(error.message)}`,
    );
  }

  return new TargetsCommandRuntimeError(
    `${prefix} ${sanitizeControlCharacters(toError(error).message)}`,
  );
}

function assertNoExtraArgs(args: string[], commandName: string): void {
  if (args.length > 0) {
    throw new TargetsCommandUsageError(
      `${commandName} does not accept extra arguments.`,
    );
  }
}

function createDependencies(
  overrides: Partial<TargetsCommandDependencies>,
): TargetsCommandDependencies {
  return {
    targetProfiles: overrides.targetProfiles ?? new TargetProfileStore(),
    executeSsh: overrides.executeSsh ?? executeSshCommand,
    buildSshArgv: overrides.buildSshArgv ?? buildSshCommandArgv,
    startPortForward: overrides.startPortForward ?? startSshPortForward,
    addSignalListener:
      overrides.addSignalListener ??
      ((signal, listener) => {
        process.on(signal, listener);
      }),
    removeSignalListener:
      overrides.removeSignalListener ??
      ((signal, listener) => {
        process.off(signal, listener);
      }),
    env: overrides.env ?? process.env,
    print: overrides.print ?? ((message: string) => console.log(message)),
    printError:
      overrides.printError ?? ((message: string) => console.error(message)),
    writeStdout:
      overrides.writeStdout ??
      ((chunk: string) => {
        process.stdout.write(chunk);
      }),
    writeStderr:
      overrides.writeStderr ??
      ((chunk: string) => {
        process.stderr.write(chunk);
      }),
  };
}

function stripLeadingNoOpSeparators(args: string[]): string[] {
  let firstNonSeparatorIndex = 0;
  while (firstNonSeparatorIndex < args.length && args[firstNonSeparatorIndex] === "--") {
    firstNonSeparatorIndex += 1;
  }

  return args.slice(firstNonSeparatorIndex);
}

function stripNoOpSeparators(args: string[]): string[] {
  return args.filter((arg) => arg !== "--");
}

function isHelpToken(token: string | undefined): boolean {
  return token === "--help" || token === "-h" || token === "help";
}

function containsHelpToken(args: readonly string[]): boolean {
  return args.some((arg) => isHelpToken(arg));
}

function containsHelpTokenBeforeExecSeparator(args: readonly string[]): boolean {
  for (const argument of args) {
    if (argument === "--") {
      return false;
    }

    if (isHelpToken(argument)) {
      return true;
    }
  }

  return false;
}
