export const STARTER_ENGINE_ID = "llama-cpp";

export const LOOPBACK_HOST = "127.0.0.1";
export const LLAMA_SERVER_COMMAND = "llama-server";
export const REDACTED_VALUE = "[REDACTED]";
export const API_KEY_ENTROPY_BYTES = 32;
export const MIN_API_KEY_LENGTH = 43;
export const DEFAULT_STARTUP_PROBE_WINDOW_MS = 300;
export const DEFAULT_STARTUP_RETRY_ATTEMPTS = 4;
export const DEFAULT_STOP_GRACE_PERIOD_MS = 2_000;
export const DEFAULT_KILL_WAIT_TIMEOUT_MS = 1_000;
export const DEFAULT_BUFFERED_LOG_CHARS = 64 * 1024;
export const DEFAULT_DIAGNOSTIC_EXCERPT_CHARS = 4 * 1024;
export const DEFAULT_READINESS_POLL_INTERVAL_MS = 200;
export const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
export const DEFAULT_READINESS_REQUEST_TIMEOUT_MS = 1_000;
export const DEFAULT_SERVER_HELP_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_HELP_OUTPUT_CHARS = 128 * 1024;
export const READINESS_ERROR_EXCERPT_CHARS = 256;
export const DEFAULT_REMOTE_HELP_CACHE_TTL_MS = 60_000;
export const DEFAULT_REMOTE_HELP_CACHE_MAX_ENTRIES = 128;
export const DEFAULT_SSH_STARTUP_RETRY_ATTEMPTS = 10;

export const RESERVED_SERVER_FLAGS = new Set([
  "-m",
  "--model",
  "--host",
  "--port",
  "--api-key",
  "--api_key",
  "--webui",
  "--no-webui",
]);

export const DENYLISTED_SERVER_FLAGS = new Set([
  "--path-prompt-cache",
  "--prompt-cache",
  "--prompt-cache-all",
  "--logdir",
  "--public",
]);

export const RESERVED_REQUEST_PARAM_KEYS = new Set(["messages", "model", "stream"]);

export const STRICT_REQUEST_PARAM_BASELINE = new Set([
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "max_tokens",
  "n",
  "presence_penalty",
  "response_format",
  "seed",
  "stop",
  "temperature",
  "top_logprobs",
  "top_p",
  "user",
]);
