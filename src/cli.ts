import {
  runServeCommand,
  ServeCommandUsageError,
  getServeCommandHelp,
} from "./cli/serve-command.ts";
import { ServeConfigurationError } from "./server/config.ts";

function printGeneralHelp(): void {
  console.log("chimera-bench commands:");
  console.log("  serve   Start the benchmark server");
  console.log("  help    Show this help message");
  console.log("");
  console.log("Use `chimera-bench serve --help` for serve command options.");
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

  console.error(`Unknown command: ${command}`);
  printGeneralHelp();
  return 2;
}
