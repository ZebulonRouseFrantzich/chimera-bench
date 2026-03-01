export function estimateTokenCount(value: string): number {
  const normalized = value.trim();
  if (!normalized) {
    return 0;
  }

  return normalized.split(/\s+/).length;
}

export function estimateTokensPerSecond(tokens: number, latencyMs: number): number {
  if (tokens <= 0 || latencyMs <= 0) {
    return 0;
  }

  return Number((tokens / (latencyMs / 1000)).toFixed(3));
}
