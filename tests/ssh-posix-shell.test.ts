import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import {
  buildPosixShellCommand,
  PosixShellQuoteError,
  quotePosixShellArg,
} from "../src/server/ssh/posix-shell.ts";

const POSIX_SH_AVAILABLE = supportsPosixSh();

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

  if (POSIX_SH_AVAILABLE) {
    test("round-trips adversarial argv corpus through sh -c", () => {
      const corpus: string[][] = [
        ["echo", "ok"],
        ["printf", "%s", "hello world"],
        ["cmd", "", "spaces and\ttabs", "line1\nline2"],
        ["dollar", "$HOME", "$(whoami)", "`id`"],
        ["pipes", "a|b", "semi;colon", "amp&&ersand"],
        ["quotes", "single'quote", 'double"quote', "back\\slash"],
        ["carriage", "line1\rline2", "tilde~user", "'; drop table users; --"],
        ["ascii", "A-Z", "0-9", "-_./"],
      ];

      for (const argv of corpus) {
        expect(roundTripArgvThroughLocalSh(argv)).toEqual(argv);
      }
    });

    test("round-trips generated argv corpus through sh -c", () => {
      const random = createDeterministicRandom(0x5eed1234);

      for (let index = 0; index < 128; index += 1) {
        const argv = createRandomArgv(random);
        expect(roundTripArgvThroughLocalSh(argv)).toEqual(argv);
      }
    });
  } else {
    test.skip("round-trips adversarial argv corpus through sh -c", () => {
      return;
    });

    test.skip("round-trips generated argv corpus through sh -c", () => {
      return;
    });
  }
});

function supportsPosixSh(): boolean {
  if (process.platform === "win32") {
    return false;
  }

  const probe = spawnSync("sh", ["-c", "printf '%s' ok"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return probe.status === 0 && probe.stdout.toString("utf8") === "ok";
}

function roundTripArgvThroughLocalSh(argv: readonly string[]): string[] {
  const command = buildPosixShellCommand(argv);
  const script = `set -- ${command}; while [ "$#" -gt 0 ]; do printf '%s\\0' "$1"; shift; done`;
  const result = spawnSync("sh", ["-c", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new Error(
      `sh -c round-trip failed with status ${String(result.status)}: ${result.stderr.toString("utf8")}`,
    );
  }

  const output = result.stdout.toString("utf8");
  if (output.length === 0) {
    return [];
  }

  const fields = output.split("\u0000");
  if (fields.at(-1) === "") {
    fields.pop();
  }

  return fields;
}

function createRandomArgv(random: () => number): string[] {
  const argvLength = 1 + Math.floor(random() * 5);
  const argv: string[] = [];

  for (let index = 0; index < argvLength; index += 1) {
    argv.push(createRandomString(random, 24));
  }

  return argv;
}

function createRandomString(random: () => number, maxLength: number): string {
  const alphabet = [
    ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    " ",
    "\t",
    "\n",
    "\r",
    "'",
    '"',
    "`",
    "$",
    ";",
    "|",
    "&",
    "(",
    ")",
    "<",
    ">",
    "\\",
    "/",
    "=",
    "+",
    "-",
    "_",
    ".",
    ",",
    ":",
    "?",
    "!",
    "@",
    "#",
    "%",
    "^",
    "*",
    "~",
    "[",
    "]",
    "{",
    "}",
  ];
  const length = Math.floor(random() * (maxLength + 1));
  let value = "";

  for (let index = 0; index < length; index += 1) {
    const alphabetIndex = Math.floor(random() * alphabet.length);
    value += alphabet[alphabetIndex] ?? "x";
  }

  return value;
}

function createDeterministicRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
