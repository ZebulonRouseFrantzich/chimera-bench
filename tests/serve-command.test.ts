import { describe, expect, test } from "bun:test";
import {
  runServeCommand,
  ServeCommandUsageError,
} from "../src/cli/serve-command.ts";

describe("runServeCommand", () => {
  test("rejects whitespace hostname in split flag form", async () => {
    await expect(runServeCommand(["--hostname", "   "])).rejects.toBeInstanceOf(
      ServeCommandUsageError,
    );
  });

  test("rejects whitespace hostname in equals flag form", async () => {
    await expect(runServeCommand(["--hostname=   "])).rejects.toBeInstanceOf(
      ServeCommandUsageError,
    );
  });

  test("rejects whitespace mdns-domain in split flag form", async () => {
    await expect(runServeCommand(["--mdns-domain", "   "])).rejects.toBeInstanceOf(
      ServeCommandUsageError,
    );
  });

  test("rejects whitespace mdns-domain in equals flag form", async () => {
    await expect(runServeCommand(["--mdns-domain=   "])).rejects.toBeInstanceOf(
      ServeCommandUsageError,
    );
  });

  test("rejects whitespace cors origin in split flag form", async () => {
    await expect(runServeCommand(["--cors", "   "])).rejects.toBeInstanceOf(
      ServeCommandUsageError,
    );
  });
});
