import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { TEST_APP_VERSION } from "./helpers/app-version.ts";

async function captureConsoleLogs(fn: () => Promise<number>): Promise<{
  readonly exitCode: number;
  readonly logs: readonly string[];
}> {
  const capturedLogs: string[] = [];
  const originalConsoleLog = console.log;
  console.log = (...args: unknown[]) => {
    capturedLogs.push(args.map((value) => String(value)).join(" "));
  };

  try {
    const exitCode = await fn();
    return {
      exitCode,
      logs: capturedLogs,
    };
  } finally {
    console.log = originalConsoleLog;
  }
}

describe("cli main", () => {
  test("prints app version for --version", async () => {
    const result = await captureConsoleLogs(async () => await main(["--version"]));
    expect(result.exitCode).toBe(0);
    expect(result.logs).toEqual([TEST_APP_VERSION]);
  });

  test("prints app version for version command", async () => {
    const result = await captureConsoleLogs(async () => await main(["version"]));
    expect(result.exitCode).toBe(0);
    expect(result.logs).toEqual([TEST_APP_VERSION]);
  });

  test("returns success for general help", async () => {
    await expect(main(["help"])).resolves.toBe(0);
  });

  test("returns success for targets help", async () => {
    await expect(main(["targets", "--help"])).resolves.toBe(0);
  });

  test("returns usage error code for targets missing subcommand", async () => {
    await expect(main(["targets"])).resolves.toBe(2);
  });

  test("returns usage error code for unknown command", async () => {
    await expect(main(["does-not-exist"])).resolves.toBe(2);
  });
});
