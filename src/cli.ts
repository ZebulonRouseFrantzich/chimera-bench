import {
  runServeCommand,
  ServeCommandUsageError,
  getServeCommandHelp,
} from "./cli/serve-command.ts";
import {
  getTargetsCommandHelp,
  runTargetsCommand,
  TargetsCommandUsageError,
} from "./cli/targets-command/index.ts";
import { ServeConfigurationError } from "./server/config.ts";
import { sanitizeControlCharacters } from "./server/http/sanitize.ts";

function printGeneralHelp(): void {
  console.log("chimera-bench commands:");
  console.log("  serve   Start the benchmark server");
  console.log("  targets Manage SSH target profiles and SSH checks");
  console.log("  help    Show this help message");
  console.log("");
  console.log("Use `chimera-bench serve --help` for serve command options.");
  console.log("Use `chimera-bench targets --help` for targets subcommands.");
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printGeneralHelp();
    return 0;
  }

  if (command === "serve") {
    try {
      await runServeCommand(args);
      return 0;
    } catch (error) {
      if (error instanceof ServeCommandUsageError) {
        console.error(`Error: ${error.message}`);
        console.error("");
        console.error(getServeCommandHelp());
        return 2;
      }

      if (error instanceof ServeConfigurationError) {
        console.error(`Configuration error: ${error.message}`);
        return 1;
      }

      if (error instanceof Error) {
        console.error(`Server failed: ${error.message}`);
      } else {
        console.error("Server failed with an unknown error.");
      }

      return 1;
    }
  }

  if (command === "targets") {
    try {
      await runTargetsCommand(args);
      return 0;
    } catch (error) {
      if (error instanceof TargetsCommandUsageError) {
        console.error(`Error: ${error.message}`);
        console.error("");
        console.error(getTargetsCommandHelp());
        return 2;
      }

      if (error instanceof Error) {
        console.error(`Targets command failed: ${error.message}`);
      } else {
        console.error("Targets command failed with an unknown error.");
      }

      return 1;
    }
  }

  console.error(`Unknown command: ${sanitizeControlCharacters(command)}`);
  printGeneralHelp();
  return 2;
}
