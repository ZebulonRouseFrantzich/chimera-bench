# SSE Testing

Test SSE endpoints using raw stream reads (no SSE parser deps).

Pattern:

- `const response = await app.request("http://localhost/event")`
- Assert status and headers (`X-Request-Id` present).
- Read via:
  - `const reader = response.body!.getReader()`
  - `const decoder = new TextDecoder()`
  - `decoder.decode(chunk.value)`
- Assert raw payload contains expected `event:` lines.

Cleanup:

- Use `runtime.closeSseStreams("test-shutdown")` when you need the server to actively close streams.
- Always `await reader.cancel()`.
- After client-cancel tests, `await Bun.sleep(0)` before asserting `runtime.getOpenSseStreamCount() === 0`.
