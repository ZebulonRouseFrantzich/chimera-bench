import { describe, expect, test } from "bun:test";
import {
  readResponseBodyWithLimit,
  ResponseBodyTooLargeError,
} from "../../src/server/engines/starter-engine/http-response-limit.ts";

describe("starter llama.cpp bounded response reader", () => {
  test("reads body when response size is within limit", async () => {
    const response = new Response("hello world");
    const result = await readResponseBodyWithLimit(response, 1024);

    expect(result.text).toBe("hello world");
    expect(result.byteLength).toBe(11);
  });

  test("fails when declared content-length exceeds limit", async () => {
    const response = new Response("ok", {
      headers: {
        "Content-Length": "200",
      },
    });

    await expect(readResponseBodyWithLimit(response, 16)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
  });

  test("fails when streamed body exceeds limit", async () => {
    const response = new Response("x".repeat(64));

    await expect(readResponseBodyWithLimit(response, 8)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
  });
});
