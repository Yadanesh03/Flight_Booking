import { CACHE_TTL_SECONDS, NEGATIVE_CACHE_SENTINEL } from '@flight/shared';
import { cacheRedis } from '../redis.js';
import { fillWithRedis } from './redisFill.js';
import { jitter } from './jitter.js';

/**
 * `getOrFill(key, ttlSeconds, loader)` (Section 14.2): read-through cache on redis-cache with
 * stampede protection. `loader` returns the value, or `null` for "not found", which is negatively
 * cached for 30 s so a hot missing id cannot hammer the database.
 *
 * Every TTL gets +/-10 % jitter. Losing any key only costs a database read (invariant 8).
 */
export function getOrFill<T>(key: string, ttlSeconds: number, loader: () => Promise<T | null>): Promise<T | null> {
  return fillWithRedis<T | null>({
    lockKey: `lock:fill:${key}`,
    readCached: async () => {
      const raw = await cacheRedis.get(key);
      if (raw === null) return undefined;
      if (raw === NEGATIVE_CACHE_SENTINEL) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        await cacheRedis.del(key); // corrupt entry: drop it and treat as a miss
        return undefined;
      }
    },
    load: loader,
    write: async (value) => {
      if (value === null) await cacheRedis.set(key, NEGATIVE_CACHE_SENTINEL, 'EX', jitter(CACHE_TTL_SECONDS.negative));
      else await cacheRedis.set(key, JSON.stringify(value), 'EX', jitter(ttlSeconds));
    }
  });
}
