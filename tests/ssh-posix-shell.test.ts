import { describe, expect, test } from "bun:test";
import {
  buildPosixShellCommand,
  PosixShellQuoteError,
  quotePosixShellArg,
} from "../src/server/ssh/posix-shell.ts";

describe("POSIX shell quoting", () => {
  test("quotes empty strings as two single quotes", () => {
    expect(quotePosixShellArg("")).toBe("''");
  });

  test("escapes embedded single quotes using close-open pattern", () => {
    expect(quotePosixShellArg("foo'bar")).toBe("'foo'\\''bar'");
  });

  test("quotes adversarial shell metacharacters", () => {
    const raw = "$(whoami);`id`|cat /tmp/file\nhello";
    expect(quotePosixShellArg(raw)).toBe("'$(whoami);`id`|cat /tmp/file\nhello'");
  });

  test("builds remote command string from argv", () => {
    expect(buildPosixShellCommand(["echo", "hello world", "foo'bar"])).toBe(
      "'echo' 'hello world' 'foo'\\''bar'",
    );
  });

  test("rejects arguments with NUL bytes", () => {
    expect(() => quotePosixShellArg("bad\u0000arg")).toThrow(PosixShellQuoteError);
    expect(() => buildPosixShellCommand(["echo", "bad\u0000arg"])).toThrow(
      PosixShellQuoteError,
    );
  });
});
