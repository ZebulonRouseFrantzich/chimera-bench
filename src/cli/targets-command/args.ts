import { sanitizeControlCharacters } from "../../server/http/sanitize.ts";
import { TargetProfileIdSchema } from "../../server/targets/target-profile.ts";
import type { ParsedExecOptions, ParsedForwardOptions } from "./types.ts";
import { TargetsCommandUsageError } from "./types.ts";

export function parseSingleProfileId(args: string[], commandName: string): string {
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

export function parseForwardOptions(args: string[]): ParsedForwardOptions {
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
        throw new TargetsCommandUsageError("targets forward accepts --remote-port at most once.");
      }

      remotePort = parsePortOption(rest[index + 1], "--remote-port");
      index += 1;
      continue;
    }

    if (token?.startsWith("--remote-port=")) {
      if (remotePort !== null) {
        throw new TargetsCommandUsageError("targets forward accepts --remote-port at most once.");
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
    throw new TargetsCommandUsageError("targets forward requires --remote-port <port>.");
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

export function parseExecOptions(args: string[]): ParsedExecOptions {
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

export function assertNoExtraArgs(args: string[], commandName: string): void {
  if (args.length > 0) {
    throw new TargetsCommandUsageError(`${commandName} does not accept extra arguments.`);
  }
}

export function stripLeadingNoOpSeparators(args: string[]): string[] {
  let firstNonSeparatorIndex = 0;
  while (firstNonSeparatorIndex < args.length && args[firstNonSeparatorIndex] === "--") {
    firstNonSeparatorIndex += 1;
  }

  return args.slice(firstNonSeparatorIndex);
}

export function stripNoOpSeparators(args: string[]): string[] {
  return args.filter((arg) => arg !== "--");
}

export function isHelpToken(token: string | undefined): boolean {
  return token === "--help" || token === "-h" || token === "help";
}

export function containsHelpToken(args: readonly string[]): boolean {
  return args.some((arg) => isHelpToken(arg));
}

export function containsHelpTokenBeforeExecSeparator(args: readonly string[]): boolean {
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
