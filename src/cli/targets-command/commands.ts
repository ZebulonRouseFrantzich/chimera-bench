/**
 * Implements `targets` subcommands against parsed argv and injected dependencies.
 *
 * Each command keeps user-facing errors actionable while redacting untrusted
 * strings and preserving signal-driven cancellation behavior for SSH flows.
 */
import { sanitizeControlCharacters } from "../../server/http/sanitize.ts";
import type { TargetProfile } from "../../server/targets/target-profile.ts";
import {
  TargetProfileNotFoundError,
  type TargetProfileStore,
} from "../../server/targets/target-profile-store.ts";
import {
  CHECK_REMOTE_ARGV,
  DEFAULT_TARGETS_CHECK_TIMEOUT_MS,
  DEFAULT_TARGETS_EXEC_TIMEOUT_MS,
  DEFAULT_TARGETS_FORWARD_STARTUP_TIMEOUT_MS,
  TARGETS_EXEC_ENABLEMENT_ENV_KEY,
} from "./constants.ts";
import {
  containsHelpToken,
  containsHelpTokenBeforeExecSeparator,
  parseExecOptions,
  parseForwardOptions,
  parseSingleProfileId,
  stripLeadingNoOpSeparators,
  stripNoOpSeparators,
  assertNoExtraArgs,
} from "./args.ts";
import { wrapSshCommandError, wrapSshPortForwardError, wrapTargetStoreError } from "./error-wrappers.ts";
import { getTargetsCommandHelp } from "./help.ts";
import { runSshCommandWithCancellation } from "./ssh-command.ts";
import type { TargetsCommandDependencies } from "./types.ts";
import { TargetsCommandRuntimeError, TargetsCommandUsageError } from "./types.ts";

export async function runListCommand(
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

export async function runShowCommand(
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

export async function runRemoveCommand(
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

export async function runCheckCommand(
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

export async function runForwardCommand(
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

    // A clean exit is only expected after a user/system signal-triggered
    // shutdown; otherwise the tunnel died unexpectedly.
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

export async function runExecCommand(
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
