import { randomUUID } from 'node:crypto';
import {
  DEGRADED_LOG_THROTTLE_MS,
  FILL_WAIT_MAX_MS,
  FILL_WAIT_POLL_JITTER_MS,
  FILL_WAIT_POLL_MS
} from '@flight/shared';
import { logThrottled, logger } from '../logger.js';
import { singleflight } from './singleflight.js';

const log = logger.child({ module: 'platform' });

export interface FillSpec<T> {
  /** Distributed fill-lock key (redis-coord), also the in-process singleflight key. */
  lockKey: string;
  /** The cached value, or `undefined` on a miss. Throws when the cache is unavailable. */
  readCached: () => Promise<T | undefined>;
  /** Reads the source of truth (one database query). */
  load: () => Promise<T>;
  /** Stores a freshly loaded value in the cache. */
  write: (value: T) => Promise<void>;
}

/** 'acquired' | 'held' (someone else is filling) | 'unavailable' (redis-coord is down: no lock). */
export type LockResult = 'acquired' | 'held' | 'unavailable';

export interface FillDeps {
  tryLock: (lockKey: string, token: string) => Promise<LockResult>;
  unlock: (lockKey: string, token: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
}

function cacheUnavailable(error: unknown): void {
  logThrottled(log, 'CACHE_UNAVAILABLE', DEGRADED_LOG_THROTTLE_MS, {
    module: 'platform',
    err: error instanceof Error ? error.message : String(error)
  });
}

/**
 * Read-through fill with cache-stampede protection (Section 14.2):
 *   1. cache hit -> return it;
 *   2. miss -> in-process singleflight (one loader call per process);
 *   3. distributed fill lock (one loader call across processes): the winner double-checks the cache,
 *      loads, writes and releases; losers poll the cache for up to FILL_WAIT_MAX_MS and then fall back
 *      to reading the database WITHOUT writing the cache.
 * Degraded modes: redis-cache down -> load directly (singleflight still applies); redis-coord down ->
 * skip the distributed lock and rely on singleflight.
 */
export async function coalescedFill<T>(spec: FillSpec<T>, deps: FillDeps): Promise<T> {
  let cached: T | undefined;
  try {
    cached = await spec.readCached();
  } catch (error) {
    cacheUnavailable(error);
    return singleflight(spec.lockKey, spec.load);
  }
  if (cached !== undefined) {
    log.debug({ event: 'CACHE_HIT', key: spec.lockKey }, 'CACHE_HIT');
    return cached;
  }
  log.debug({ event: 'CACHE_MISS', key: spec.lockKey }, 'CACHE_MISS');
  return singleflight(spec.lockKey, () => fillOnce(spec, deps));
}

async function fillOnce<T>(spec: FillSpec<T>, deps: FillDeps): Promise<T> {
  const token = randomUUID();
  const lock = await deps.tryLock(spec.lockKey, token);

  if (lock === 'held') return waitForOtherFiller(spec, deps);

  try {
    // Double-check: another process may have filled the cache while we waited for the lock.
    try {
      const again = await spec.readCached();
      if (again !== undefined) return again;
    } catch (error) {
      cacheUnavailable(error);
      return await spec.load();
    }

    const data = await spec.load(); // the single database query
    try {
      await spec.write(data);
      log.info({ event: 'CACHE_FILL', key: spec.lockKey }, 'CACHE_FILL');
    } catch (error) {
      cacheUnavailable(error); // the caller still gets the data
    }
    return data;
  } finally {
    if (lock === 'acquired') await deps.unlock(spec.lockKey, token);
  }
}

async function waitForOtherFiller<T>(spec: FillSpec<T>, deps: FillDeps): Promise<T> {
  const deadline = deps.now() + FILL_WAIT_MAX_MS;
  while (deps.now() < deadline) {
    await deps.sleep(FILL_WAIT_POLL_MS + Math.floor(deps.random() * (FILL_WAIT_POLL_JITTER_MS + 1)));
    try {
      const value = await spec.readCached();
      if (value !== undefined) return value;
    } catch (error) {
      cacheUnavailable(error);
      return spec.load();
    }
  }
  log.warn({ event: 'CACHE_FILL_WAIT_TIMEOUT', key: spec.lockKey }, 'CACHE_FILL_WAIT_TIMEOUT');
  return spec.load(); // fallback: database read, no cache write
}
