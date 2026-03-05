import { describe, expect, test } from "bun:test";
import {
  extractFlagValue,
  parseFlagIntValue,
} from "../../src/server/engines/starter-engine/utils.ts";

describe("starter llama.cpp utility helpers", () => {
  test("extractFlagValue uses the last occurrence when duplicates exist", () => {
    const args = ["--ctx-size", "4096", "--ctx-size", "8192"];

    expect(extractFlagValue(args, "--ctx-size")).toBe("8192");
    expect(parseFlagIntValue(args, "--ctx-size")).toBe(8192);
  });
});
