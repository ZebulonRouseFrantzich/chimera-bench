export const STARTER_ENGINE_ID = "llama-cpp";

export const STARTER_ENGINE_SUMMARY = {
  id: STARTER_ENGINE_ID,
  displayName: "llama.cpp",
  version: "unknown",
  capabilities: {
    chatCompletions: true,
    localTarget: true,
    streaming: true,
  },
  environment: {
    status: "unknown",
    message: "Environment validation is not wired yet.",
  },
} as const;
