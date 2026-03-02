import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";

describe("cli main", () => {
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
