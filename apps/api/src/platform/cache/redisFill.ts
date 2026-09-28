import { FILL_LOCK_TTL_MS } from '@flight/shared';
import { coordRedis } from '../redis.js';
import { coalescedFill, type FillDeps, type FillSpec } from './fill.js';

/** Production dependencies for the fill engine: the distributed lock lives in redis-coord. */
const redisFillDeps: FillDeps = {
  async tryLock(lockKey, token) {
    try {
      const reply = await coordRedis.set(lockKey, token, 'PX', FILL_LOCK_TTL_MS, 'NX');
      return reply === 'OK' ? 'acquired' : 'held';
    } catch {
      return 'unavailable'; // redis-coord down: skip the distributed lock, singleflight still applies
    }
  },
  async unlock(lockKey, token) {
    try {
      // Compare-and-delete: releases only OUR lock, never one that expired and was re-acquired.
      await coordRedis.compareAndDelete(lockKey, token);
    } catch {
      // The lock has a 5 s TTL and expires by itself.
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  random: Math.random
};

/** `coalescedFill` wired to the real Redis lock. */
export function fillWithRedis<T>(spec: FillSpec<T>): Promise<T> {
  return coalescedFill(spec, redisFillDeps);
}
