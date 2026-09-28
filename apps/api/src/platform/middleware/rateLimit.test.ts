import { describe, expect, it } from 'vitest';

/**
 * The sliding-window math itself (Section 12.1) — a pure re-implementation of `rateLimit.lua`'s
 * formula, checked against the Lua script directly in tests/integration/lua-*.test.ts equivalents
 * would require Redis; this documents and verifies the arithmetic in isolation.
 */
function weighted(prevCount: number, curCount: number, elapsedMs: number, windowMs: number): number {
  return prevCount * ((windowMs - elapsedMs) / windowMs) + curCount;
}

describe('sliding window counter formula', () => {
  const windowMs = 60_000;

  it('at the very start of a window, only the previous window counts (fully weighted)', () => {
    expect(weighted(10, 0, 0, windowMs)).toBe(10);
  });

  it('at the very end of a window, the previous window no longer counts', () => {
    expect(weighted(10, 0, windowMs, windowMs)).toBe(0);
  });

  it('halfway through the window, the previous window counts at half weight', () => {
    expect(weighted(10, 0, windowMs / 2, windowMs)).toBe(5);
  });

  it('smooths a burst at a window boundary: a full previous window plus a fresh current one never double-counts to 2x the limit', () => {
    const limit = 10;
    // 10 requests right before the boundary (previous window is now full), then check immediately
    // after the boundary: naive fixed-window counting would allow 10 more immediately (20 in ~0ms).
    const justAfterBoundary = weighted(limit, 0, 1, windowMs);
    expect(justAfterBoundary).toBeGreaterThan(limit - 1); // still counts as basically a full window
    expect(justAfterBoundary).toBeLessThanOrEqual(limit);
  });

  it('is monotonically decreasing in elapsed time for a fixed previous count', () => {
    const values = [0, 10_000, 20_000, 30_000, 45_000, 59_999].map((elapsed) => weighted(20, 0, elapsed, windowMs));
    for (let i = 1; i < values.length; i += 1) expect(values[i]).toBeLessThan(values[i - 1]);
  });
});
