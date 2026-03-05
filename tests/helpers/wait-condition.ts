const DEFAULT_WAIT_MAX_ATTEMPTS = 100;
const DEFAULT_WAIT_INTERVAL_MS = 50;

export async function waitForCondition(
  predicate: () => boolean,
  options: {
    maxAttempts?: number;
    intervalMs?: number;
  } = {},
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_WAIT_MAX_ATTEMPTS;
  const intervalMs = options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (predicate()) {
      return;
    }

    await Bun.sleep(intervalMs);
  }

  throw new Error("Condition did not become true in time.");
}
