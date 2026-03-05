import { describe, expect, test } from "bun:test";
import {
  parsePromptTooLargeError,
  sanitizeChatCompletionRawResponse,
} from "../../src/server/engines/starter-engine/chat-completions-response.ts";

describe("starter llama.cpp chat response shaping", () => {
  test("sanitizes raw response to allowlisted fields", () => {
    const rawResponse = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1_700_000_000,
      model: "model.gguf",
      system_fingerprint: "fp-test",
      internal_debug_token: "secret",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "hello",
            hidden: "remove",
          },
          trace_id: "remove",
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 7,
        total_tokens: 19,
        private_counter: 999,
      },
    };

    const sanitized = sanitizeChatCompletionRawResponse(rawResponse);
    expect(sanitized.internal_debug_token).toBeUndefined();
    expect((sanitized.choices as Array<Record<string, unknown>>)[0]?.trace_id).toBeUndefined();
    expect(sanitized.object).toBe("chat.completion");
    expect((sanitized.usage as Record<string, unknown>).completion_tokens).toBe(7);
  });

  test("maps upstream context-overflow response to prompt-too-large signal", () => {
    const parsed = parsePromptTooLargeError(
      400,
      JSON.stringify({
        error: {
          type: "exceed_context_size_error",
          message: "request (40849 tokens) exceeds the available context size (4096)",
          n_prompt_tokens: 40849,
          n_ctx: 4096,
        },
      }),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.details.promptCount).toBe(40849);
    expect(parsed?.details.contextWindow).toBe(4096);
  });
});
