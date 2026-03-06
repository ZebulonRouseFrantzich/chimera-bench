/**
 * Binary entrypoint for compiled and script-based CLI execution.
 *
 * For programmatic usage, import and call `main` from `src/cli.ts` directly.
 */
import { main } from "./cli.ts";

void main(process.argv.slice(2))
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error) => {
    if (error instanceof Error) {
      console.error(`chimera-bench failed: ${error.message}`);
      if (process.env.CHIMERA_BENCH_DEBUG === "1" && error.stack) {
        console.error(error.stack);
      }
    } else {
      console.error("chimera-bench failed with an unknown error.");
    }

    process.exit(1);
  });
