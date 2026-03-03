/**
 * Entry point for `chimera-bench targets` CLI handling.
 *
 * This module dispatches parsed subcommands to focused handlers while exposing
 * the public help text and usage error type consumed by the top-level CLI.
 */
import { createDependencies } from "./dependencies.ts";
import { getTargetsCommandHelp } from "./help.ts";
import {
  runCheckCommand,
  runExecCommand,
  runForwardCommand,
  runListCommand,
  runRemoveCommand,
  runShowCommand,
} from "./commands.ts";
import { isHelpToken, stripLeadingNoOpSeparators } from "./args.ts";
import type { TargetsCommandDependencies } from "./types.ts";
import { TargetsCommandUsageError } from "./types.ts";

export { getTargetsCommandHelp, TargetsCommandUsageError };

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
