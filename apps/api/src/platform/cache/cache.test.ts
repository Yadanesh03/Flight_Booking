import { describe, expect, it } from 'vitest';
import { CACHE_TTL_JITTER, FILL_WAIT_MAX_MS, FILL_WAIT_POLL_JITTER_MS, FILL_WAIT_POLL_MS } from '@flight/shared';
import { coalescedFill, type FillDeps, type FillSpec, type LockResult } from './fill.js';
import { jitter } from './jitter.js';
import { inFlightCount, singleflight } from './singleflight.js';

describe('jitter', () => {
  it('stays within +/-10 % and rounds to whole seconds', () => {
    for (const ttl of [30, 60, 600, 21_600, 86_400]) {
      for (let i = 0; i < 500; i += 1) {
        const value = jitter(ttl);
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(Math.round(ttl * (1 - CACHE_TTL_JITTER)));
        expect(value).toBeLessThanOrEqual(Math.round(ttl * (1 + CACHE_TTL_JITTER)));
      }
    }
  });

  it('spans the whole range at the extremes of the random source', () => {
    expect(jitter(1000, () => 0)).toBe(900);
    expect(jitter(1000, () => 0.5)).toBe(1000);
    expect(jitter(1000, () => 0.999999)).toBe(1100);
  });

  it('actually varies, so keys written together do not expire together', () => {
    const values = new Set(Array.from({ length: 200 }, () => jitter(600)));
    expect(values.size).toBeGreaterThan(20);
  });

  it('never returns less than 1 second', () => {
    expect(jitter(1, () => 0)).toBeGreaterThanOrEqual(1);
  });
});

describe('singleflight', () => {
  it('shares one promise between concurrent callers with the same key', async () => {
    let calls = 0;
    const slow = () =>
      new Promise<number>((resolve) => {
        calls += 1;
        setTimeout(() => resolve(42), 20);
      });
    const results = await Promise.all(Array.from({ length: 50 }, () => singleflight('k1', slow)));
    expect(calls).toBe(1);
    expect(new Set(results)).toEqual(new Set([42]));
    expect(inFlightCount()).toBe(0);
  });

  it('runs different keys independently and allows a fresh flight after completion', async () => {
    let calls = 0;
    const fn = async () => ++calls;
    await Promise.all([singleflight('a', fn), singleflight('b', fn)]);
    expect(calls).toBe(2);
    await singleflight('a', fn);
    expect(calls).toBe(3);
  });

  it('propagates rejections to every waiter and clears the key so the next call retries', async () => {
    let calls = 0;
    const failing = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error('boom');
    };
    const settled = await Promise.allSettled([singleflight('f', failing), singleflight('f', failing), singleflight('f', failing)]);
    expect(calls).toBe(1);
    expect(settled.every((s) => s.status === 'rejected')).toBe(true);
    expect(inFlightCount()).toBe(0);
    await expect(singleflight('f', async () => 'ok')).resolves.toBe('ok');
  });
});

/** An in-memory cache + lock + virtual clock for the fill engine. */
function harness(options: { lock?: LockResult | (() => LockResult); startCached?: string | undefined } = {}) {
  const state = {
    cached: options.startCached,
    loads: 0,
    writes: [] as string[],
    unlocks: 0,
    lockCalls: 0,
    reads: 0,
    clock: 0,
    sleeps: [] as number[]
  };
  const deps: FillDeps = {
    tryLock: async () => {
      state.lockCalls += 1;
      const configured = options.lock ?? 'acquired';
      return typeof configured === 'function' ? configured() : configured;
    },
    unlock: async () => {
      state.unlocks += 1;
    },
    sleep: async (ms) => {
      state.sleeps.push(ms);
      state.clock += ms;
    },
    now: () => state.clock,
    random: () => 0.5
  };
  const spec = (overrides: Partial<FillSpec<string>> = {}): FillSpec<string> => ({
    lockKey: `lock:fill:test:${Math.random()}`,
    readCached: async () => {
      state.reads += 1;
      return state.cached;
    },
    load: async () => {
      state.loads += 1;
      return 'from-db';
    },
    write: async (value) => {
      state.writes.push(value);
      state.cached = value;
    },
    ...overrides
  });
  return { state, deps, spec };
}

describe('coalescedFill', () => {
  it('returns a cached value without loading, locking or writing', async () => {
    const { state, deps, spec } = harness({ startCached: 'cached' });
    await expect(coalescedFill(spec(), deps)).resolves.toBe('cached');
    expect(state.loads).toBe(0);
    expect(state.lockCalls).toBe(0);
    expect(state.writes).toEqual([]);
  });

  it('on a miss: locks, loads once, writes, and releases only its own lock', async () => {
    const { state, deps, spec } = harness();
    await expect(coalescedFill(spec(), deps)).resolves.toBe('from-db');
    expect(state.loads).toBe(1);
    expect(state.writes).toEqual(['from-db']);
    expect(state.lockCalls).toBe(1);
    expect(state.unlocks).toBe(1);
  });

  it('double-checks the cache after acquiring the lock and skips the load if it was filled meanwhile', async () => {
    const { state, deps, spec } = harness();
    let reads = 0;
    const result = await coalescedFill(
      spec({
        readCached: async () => {
          reads += 1;
          return reads === 1 ? undefined : 'filled-by-someone-else'; // miss, then hit after the lock
        }
      }),
      deps
    );
    expect(result).toBe('filled-by-someone-else');
    expect(state.loads).toBe(0);
    expect(state.unlocks).toBe(1);
  });

  it('200 concurrent misses on one key cost exactly one load (singleflight + lock)', async () => {
    const { state, deps, spec } = harness();
    const shared = spec({
      load: async () => {
        state.loads += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return 'from-db';
      }
    });
    const results = await Promise.all(Array.from({ length: 200 }, () => coalescedFill(shared, deps)));
    expect(new Set(results)).toEqual(new Set(['from-db']));
    expect(state.loads).toBe(1);
    expect(state.lockCalls).toBe(1);
  });

  it('a lock loser polls the cache and returns the winner\'s value without loading', async () => {
    const { state, deps, spec } = harness({ lock: 'held' });
    let polls = 0;
    const result = await coalescedFill(
      spec({
        readCached: async () => {
          polls += 1;
          return polls >= 4 ? 'winner-value' : undefined; // initial read + 2 misses, then the winner writes
        }
      }),
      deps
    );
    expect(result).toBe('winner-value');
    expect(state.loads).toBe(0);
    expect(state.writes).toEqual([]);
    expect(state.unlocks).toBe(0); // never held the lock
    expect(state.sleeps.length).toBe(3);
    for (const ms of state.sleeps) {
      expect(ms).toBeGreaterThanOrEqual(FILL_WAIT_POLL_MS);
      expect(ms).toBeLessThanOrEqual(FILL_WAIT_POLL_MS + FILL_WAIT_POLL_JITTER_MS);
    }
  });

  it('a lock loser gives up after the max wait and reads the database WITHOUT writing the cache', async () => {
    const { state, deps, spec } = harness({ lock: 'held' });
    await expect(coalescedFill(spec(), deps)).resolves.toBe('from-db');
    expect(state.loads).toBe(1);
    expect(state.writes).toEqual([]);
    expect(state.clock).toBeGreaterThanOrEqual(FILL_WAIT_MAX_MS);
    expect(state.clock).toBeLessThan(FILL_WAIT_MAX_MS + FILL_WAIT_POLL_MS + FILL_WAIT_POLL_JITTER_MS + 1);
  });

  it('degraded: redis-coord down (no lock) still loads once via singleflight and writes', async () => {
    const { state, deps, spec } = harness({ lock: 'unavailable' });
    const shared = spec({
      load: async () => {
        state.loads += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 'from-db';
      }
    });
    const results = await Promise.all(Array.from({ length: 30 }, () => coalescedFill(shared, deps)));
    expect(new Set(results)).toEqual(new Set(['from-db']));
    expect(state.loads).toBe(1);
    expect(state.writes).toEqual(['from-db']);
    expect(state.unlocks).toBe(0); // nothing to release
  });

  it('degraded: redis-cache down -> loads directly (still coalesced) and never touches lock or write', async () => {
    const { state, deps, spec } = harness();
    const down = spec({
      readCached: async () => {
        throw new Error('ECONNREFUSED');
      },
      load: async () => {
        state.loads += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 'from-db';
      }
    });
    const results = await Promise.all(Array.from({ length: 25 }, () => coalescedFill(down, deps)));
    expect(new Set(results)).toEqual(new Set(['from-db']));
    expect(state.loads).toBe(1);
    expect(state.lockCalls).toBe(0);
    expect(state.writes).toEqual([]);
  });

  it('a failing cache write does not fail the request or leak the lock', async () => {
    const { state, deps, spec } = harness();
    await expect(
      coalescedFill(
        spec({
          write: async () => {
            throw new Error('cache write failed');
          }
        }),
        deps
      )
    ).resolves.toBe('from-db');
    expect(state.unlocks).toBe(1);
  });

  it('releases the lock and propagates the error when the loader throws', async () => {
    const { state, deps, spec } = harness();
    await expect(
      coalescedFill(
        spec({
          load: async () => {
            throw new Error('db down');
          }
        }),
        deps
      )
    ).rejects.toThrow('db down');
    expect(state.unlocks).toBe(1);
    expect(state.writes).toEqual([]);
  });

  it('treats a cached null as a hit (negative caching) rather than a miss', async () => {
    let loads = 0;
    const result = await coalescedFill<null | string>(
      {
        lockKey: 'lock:fill:neg',
        readCached: async () => null, // negative-cache hit
        load: async () => {
          loads += 1;
          return 'x';
        },
        write: async () => undefined
      },
      harness().deps
    );
    expect(result).toBeNull();
    expect(loads).toBe(0);
  });
});
