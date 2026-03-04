export function sweepExpiredCacheEntries<Value>(
  cache: Map<
    string,
    {
      expiresAt: number;
      value: Value;
    }
  >,
  nowMs: number,
): void {
  for (const [cacheKey, cacheEntry] of cache) {
    if (cacheEntry.expiresAt <= nowMs) {
      cache.delete(cacheKey);
    }
  }
}

export function trimCacheEntries<Value>(
  cache: Map<
    string,
    {
      expiresAt: number;
      value: Value;
    }
  >,
  maxEntries: number,
): void {
  if (maxEntries < 1) {
    cache.clear();
    return;
  }

  while (cache.size > maxEntries) {
    const oldestEntry = cache.keys().next().value;
    if (typeof oldestEntry !== "string") {
      break;
    }

    cache.delete(oldestEntry);
  }
}
