# llama.cpp Case Execution

Execute real llama-server inference with bounded response handling and safe diagnostics.

## Request contract

- Call `POST /v1/chat/completions` on the active run endpoint.
- Send `Authorization: Bearer <runApiKey>` and `Content-Type: application/json`.
- Request body must include core-owned fields:
  - `model` (from normalized run model identifier)
  - `messages` (from case prompt/messages)
  - `stream: false`
- Spread sanitized `requestParams` after removing reserved keys: `messages`, `model`, `stream`.

## Prompt-fit preflight

- If `--ctx-size` is present, call `POST /tokenize` with `{ content, add_special: true }`.
- Compare prompt tokens + conservative overhead to ctx-size.
- Fail early with `VALIDATION_PROMPT_TOO_LARGE` when prompt cannot fit.
- If `--ctx-size` is absent:
  - skip preflight,
  - emit one-time per-run diagnostic,
  - still map upstream context-overflow responses to `VALIDATION_PROMPT_TOO_LARGE`.

## Response safety and parsing

- Read response body with a hard byte limit (bounded streaming read; content-length only advisory).
- On limit breach, fail with `ENGINE_EXECUTION_FAILED`.
- On non-2xx, return stable `ENGINE_EXECUTION_FAILED` unless prompt-overflow mapping applies.
- Keep warn diagnostics metadata-only (status/size/reason); do not log response-body excerpts by default.
- Parse JSON and extract assistant output text:
  - prefer `choices[0].message` when role is `assistant` (or absent),
  - fallback to `choices[0].text`,
  - fail when no assistant output is available.
- Persist only allowlisted `rawResponse` fields (id/object/created/model/system_fingerprint/choices subset/usage subset).

## Cancellation

- Propagate `AbortError` without remapping.
