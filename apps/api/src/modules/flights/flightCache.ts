import { DEGRADED_LOG_THROTTLE_MS } from '@flight/shared';
import { logThrottled, moduleLogger } from '../../platform/logger.js';
import { cacheRedis, coordRedis } from '../../platform/redis.js';

const log = moduleLogger('flights');

/**
 * Cache keys owned by the flights module (`fs:` prefix, Section 9). Cached values live in
 * redis-cache and may vanish at any time; only the search VERSION counter is in redis-coord.
 */
export const AIRPORTS_KEY = 'fs:airports';
export const flightKey = (flightId: number): string => `fs:flight:${flightId}`;
export const searchKey = (version: string, from: string, to: string, date: string, sort: string): string =>
  `fs:search:v${version}:${from}:${to}:${date}:${sort}`;
const SEARCH_VERSION_KEY = 'fs:searchver';

/**
 * Current search-results version (missing = 0). Returns `undefined` when redis-coord is unavailable:
 * the caller then bypasses the search cache instead of guessing a version, which is always correct.
 */
export async function readSearchVersion(): Promise<string | undefined> {
  try {
    return (await coordRedis.get(SEARCH_VERSION_KEY)) ?? '0';
  } catch (error) {
    logThrottled(log, 'CACHE_UNAVAILABLE', DEGRADED_LOG_THROTTLE_MS, { err: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

/**
 * After every committed flight write (Section 13.2): `DEL fs:flight:<id>` and `INCR fs:searchver`.
 * Bumping the version makes every cached search result unreachable at once, so a newly published or
 * cancelled flight shows up in the very next search instead of after the 60 s TTL.
 * Best effort: a Redis failure here never fails the write (staleness is bounded by the cache TTLs).
 */
export async function invalidateFlightCaches(flightId: number): Promise<void> {
  const failures: unknown[] = [];
  await Promise.all([
    cacheRedis.del(flightKey(flightId)).catch((error: unknown) => failures.push(error)),
    coordRedis.incr(SEARCH_VERSION_KEY).catch((error: unknown) => failures.push(error))
  ]);
  if (failures.length > 0) {
    logThrottled(log, 'CACHE_UNAVAILABLE', DEGRADED_LOG_THROTTLE_MS, {
      operation: 'invalidateFlightCaches',
      flightId,
      err: String(failures[0])
    });
  }
}

export async function invalidateAirports(): Promise<void> {
  await cacheRedis.del(AIRPORTS_KEY).catch((error: unknown) => {
    logThrottled(log, 'CACHE_UNAVAILABLE', DEGRADED_LOG_THROTTLE_MS, { operation: 'invalidateAirports', err: String(error) });
  });
}
