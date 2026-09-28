const inFlight = new Map<string, Promise<unknown>>();

/**
 * In-process request coalescing (Section 14.2, layer 1): concurrent callers for the same key share
 * one promise, so N simultaneous cache misses cost one loader call in this process.
 */
export function singleflight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing as Promise<T>;
  const promise = fn().finally(() => {
    // Only clear our own entry (a newer flight for the same key must not be removed).
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

/** Test helper: number of keys currently in flight. */
export function inFlightCount(): number {
  return inFlight.size;
}
