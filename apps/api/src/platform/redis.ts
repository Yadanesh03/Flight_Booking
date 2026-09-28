import { readFileSync } from 'node:fs';
import { Redis, type RedisOptions } from 'ioredis';
import { config } from './config.js';
import { AppError } from './errors.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'platform' });

function lua(name: string): string {
  return readFileSync(new URL(`./lua/${name}.lua`, import.meta.url), 'utf8');
}

/** Commands registered on redis-coord (sessions, rate limits, holds, fill locks). */
export interface CoordCommands {
  /** KEYS: current, previous window counters. Returns [allowed, remaining, retryAfterMs]. */
  rateLimit(currentKey: string, previousKey: string, limit: number, windowMs: number, elapsedMs: number): Promise<[number, number, number]>;
  /** Deletes `key` only if it still holds `token`. */
  compareAndDelete(key: string, token: string): Promise<number>;
  /** See holdAcquire.lua. Returns ['OK', added] | ['CONFLICT', ...seatIds] | ['SEAT_LIMIT'] | ['FLIGHT_LIMIT']. */
  holdAcquire(
    holdsKey: string,
    userHoldsKey: string,
    userId: string,
    flightId: string,
    ttlSeconds: number,
    maxSeatsPerFlight: number,
    maxFlights: number,
    ...seatIds: string[]
  ): Promise<string[]>;
  /** See holdRelease.lua. Returns the number of holds released. */
  holdRelease(holdsKey: string, userHoldsKey: string, userId: string, flightId: string, ...seatIds: string[]): Promise<number>;
}

/** Commands registered on redis-cache. */
export interface CacheCommands {
  /** Version-guarded seat status fill. Returns 1 when written, 0 when skipped (stale). */
  seatsFill(statusKey: string, versionKey: string, expectedVersion: string, ttlSeconds: number, ...seatStatusPairs: string[]): Promise<number>;
  /** Bumps the version, and marks seats 'B' if the status hash exists. */
  seatsMarkBooked(statusKey: string, versionKey: string, ...seatIds: string[]): Promise<number>;
}

export type CoordRedis = Redis & CoordCommands;
export type CacheRedis = Redis & CacheCommands;

function baseOptions(name: string): RedisOptions {
  return {
    // Fail fast instead of queueing commands while disconnected: degraded modes (Section 10.3,
    // 14.2) depend on Redis errors surfacing immediately rather than hanging requests.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 2000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
    connectionName: `flight-booking-${name}`
  };
}

function attachLogging(client: Redis, name: string): void {
  let lastError = 0;
  client.on('error', (error: Error) => {
    // ioredis emits 'error' on every failed reconnect; log at most every 10 s.
    const now = Date.now();
    if (now - lastError > 10_000) {
      lastError = now;
      log.warn({ redis: name, err: error.message }, 'redis error');
    }
  });
}

export const cacheRedis = new Redis(config.redisCacheUrl, baseOptions('cache')) as CacheRedis;
export const coordRedis = new Redis(config.redisCoordUrl, baseOptions('coord')) as CoordRedis;
attachLogging(cacheRedis, 'cache');
attachLogging(coordRedis, 'coord');

// All Lua scripts are registered at startup (Section 7.4). ioredis uses EVALSHA and falls back to
// EVAL automatically after a NOSCRIPT error (e.g. after a Redis restart).
coordRedis.defineCommand('rateLimit', { numberOfKeys: 2, lua: lua('rateLimit') });
coordRedis.defineCommand('compareAndDelete', { numberOfKeys: 1, lua: lua('compareAndDelete') });
coordRedis.defineCommand('holdAcquire', { numberOfKeys: 2, lua: lua('holdAcquire') });
coordRedis.defineCommand('holdRelease', { numberOfKeys: 2, lua: lua('holdRelease') });
cacheRedis.defineCommand('seatsFill', { numberOfKeys: 2, lua: lua('seatsFill') });
cacheRedis.defineCommand('seatsMarkBooked', { numberOfKeys: 2, lua: lua('seatsMarkBooked') });

/** Waits for both clients to be ready; resolves either way after `timeoutMs` so the app can start degraded. */
export async function waitForRedis(timeoutMs: number): Promise<{ cache: boolean; coord: boolean }> {
  const ready = (client: Redis): Promise<boolean> =>
    new Promise((resolve) => {
      if (client.status === 'ready') {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => resolve(false), timeoutMs);
      client.once('ready', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  const [cache, coord] = await Promise.all([ready(cacheRedis), ready(coordRedis)]);
  return { cache, coord };
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([cacheRedis.quit(), coordRedis.quit()]);
  cacheRedis.disconnect();
  coordRedis.disconnect();
}

/**
 * Runs a redis-coord operation that a feature cannot work without (sessions, holds, ...). Any Redis
 * failure becomes 503 SERVICE_DEGRADED: we refuse rather than act without coordination (invariant 9).
 */
export async function coordGuard<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('SERVICE_DEGRADED', { cause: error });
  }
}
