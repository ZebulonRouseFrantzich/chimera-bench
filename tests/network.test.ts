import { describe, expect, test } from "bun:test";
import { isLoopbackHost } from "../src/server/network.ts";

describe("isLoopbackHost", () => {
  test("accepts loopback hostnames", async () => {
    expect(await isLoopbackHost("127.0.0.1")).toBe(true);
    expect(await isLoopbackHost("127.6.7.8")).toBe(true);
    expect(await isLoopbackHost("::1")).toBe(true);
    expect(await isLoopbackHost("[::1]")).toBe(true);
    expect(await isLoopbackHost("0:0:0:0:0:0:0:1")).toBe(true);
    expect(await isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
  });

  test("rejects non-loopback hostnames", async () => {
    expect(await isLoopbackHost("0.0.0.0")).toBe(false);
    expect(await isLoopbackHost("192.168.1.100")).toBe(false);
    expect(await isLoopbackHost("example.invalid")).toBe(false);
  });
});
