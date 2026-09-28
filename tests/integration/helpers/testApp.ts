import { createServer, type Server } from 'node:http';
import type { Express } from 'express';
import { sql } from 'drizzle-orm';
import supertest from 'supertest';
import { runMigrations } from '../../../apps/api/src/db/migrate.js';
import { createApp } from '../../../apps/api/src/app.js';
import { config } from '../../../apps/api/src/platform/config.js';
import { closeDb, db } from '../../../apps/api/src/platform/db.js';
import { cacheRedis, closeRedis, coordRedis, waitForRedis } from '../../../apps/api/src/platform/redis.js';
import { clearTestHooks, resetTestCounters } from '../../../apps/api/src/platform/testSupport.js';

/** The origin the API's CSRF check expects (ALLOWED_ORIGIN). */
export const ORIGIN = config.allowedOrigin;

/**
 * Hard safety guard: integration tests TRUNCATE tables and FLUSHDB Redis, so refuse to run against
 * anything that is not the dedicated test database / Redis logical database 1.
 */
function assertIsolatedTestEnvironment(): void {
  if (!config.isTest) throw new Error('Integration tests must run with NODE_ENV=test.');
  const dbName = new URL(config.databaseUrl).pathname.replace('/', '');
  if (dbName !== 'flight_booking_test') {
    throw new Error(`Refusing to run integration tests against database "${dbName}" (expected flight_booking_test).`);
  }
  for (const url of [config.redisCacheUrl, config.redisCoordUrl]) {
    if (new URL(url).pathname !== '/1') throw new Error(`Refusing to flush Redis ${url}: tests must use logical database /1.`);
  }
}

export async function startTestApp(): Promise<Express> {
  assertIsolatedTestEnvironment();
  await runMigrations();
  const redis = await waitForRedis(5000);
  if (!redis.cache || !redis.coord) throw new Error(`Redis is not available: ${JSON.stringify(redis)}`);
  const app = createApp();
  await listen(app);
  await resetState();
  return app;
}

/**
 * One listening server per app, started (and awaited) up front: supertest would otherwise open an
 * ephemeral server per parallel request, or race `listen()` and pile up listeners.
 */
const servers = new Map<Express, Server>();

async function listen(app: Express): Promise<void> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.set(app, server);
}

function serverFor(app: Express): Server {
  const server = servers.get(app);
  if (server === undefined) throw new Error('startTestApp() must be awaited before creating a client');
  return server;
}

export async function stopTestApp(): Promise<void> {
  for (const server of servers.values()) await new Promise<void>((resolve) => server.close(() => resolve()));
  servers.clear();
  clearTestHooks();
  await closeRedis();
  await closeDb();
}

/**
 * Empties every application table, both Redis test databases, counters and fault hooks.
 * DELETE rather than TRUNCATE: TRUNCATE recreates the tablespace and costs ~1 s per table on
 * InnoDB/Windows, while DELETE on these small tables takes milliseconds. Tests never rely on ids
 * restarting at 1.
 */
export async function resetState(): Promise<void> {
  assertIsolatedTestEnvironment();
  const [rows] = (await db.execute(
    sql`SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND table_name NOT LIKE '\\_\\_drizzle%'`
  )) as unknown as [Array<{ name: string }>];
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  try {
    for (const { name } of rows) await db.execute(sql.raw(`DELETE FROM \`${name}\``));
  } finally {
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  }
  await Promise.all([cacheRedis.flushdb(), coordRedis.flushdb()]);
  resetTestCounters();
  clearTestHooks();
}

/**
 * A supertest agent with a cookie jar that sends the allowed Origin on state-changing requests,
 * like a browser on the SPA's origin would. Pass `sid` to act as an already-logged-in user without
 * going through /login (fixtures do this to skip bcrypt).
 */
let clientCounter = 0;

/** A unique private address per client, e.g. 10.20.3.7, sent as X-Forwarded-For (the app runs with TRUST_PROXY in tests). */
function nextClientIp(): string {
  clientCounter += 1;
  return `10.20.${(clientCounter >> 8) & 255}.${clientCounter & 255}`;
}

export function client(app: Express, origin: string | null = ORIGIN, sid?: string, ip: string = nextClientIp()) {
  const agent = supertest.agent(serverFor(app));
  const prepare = (test: supertest.Test, mutating: boolean): supertest.Test => {
    let prepared = test.set('X-Forwarded-For', ip);
    if (mutating && origin !== null) prepared = prepared.set('Origin', origin);
    if (sid !== undefined) prepared = prepared.set('Cookie', `sid=${sid}`);
    return prepared;
  };
  return {
    agent,
    get: (path: string) => prepare(agent.get(path), false),
    post: (path: string) => prepare(agent.post(path), true),
    put: (path: string) => prepare(agent.put(path), true),
    patch: (path: string) => prepare(agent.patch(path), true),
    delete: (path: string) => prepare(agent.delete(path), true)
  };
}

export type TestClient = ReturnType<typeof client>;

/**
 * Simulates one Redis instance going down for the duration of `fn`: the app's client is
 * disconnected (no auto-reconnect), so every command fails immediately exactly as it would against a
 * stopped server, then it is reconnected. (The tests share their Redis with a developer's dev
 * server, so they cannot stop the real process.)
 */
export async function withRedisDown<T>(which: 'cache' | 'coord', fn: () => Promise<T>): Promise<T> {
  const target = which === 'cache' ? cacheRedis : coordRedis;
  const waitForStatus = async (status: string): Promise<void> => {
    for (let i = 0; i < 100 && target.status !== status; i += 1) await new Promise((resolve) => setTimeout(resolve, 30));
    if (target.status !== status) throw new Error(`redis-${which} did not reach status "${status}" (still "${target.status}")`);
  };
  const reconnect = async (): Promise<void> => {
    // ioredis' `disconnect()` transitions to "end" asynchronously; `connect()` throws if called before
    // that lands ("Redis is already connecting/connected").
    await waitForStatus('end');
    await target.connect();
    await waitForStatus('ready');
  };
  target.disconnect();
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    await reconnect();
    throw error;
  }
  await reconnect();
  return result;
}

/**
 * Clears rate-limit counters (the `rl:*` keys in redis-coord). Tests that are about something else
 * (idempotency, validation) but happen to make more requests than a route's per-minute limit allows
 * use this between the unrelated bursts, so they don't have to also account for rate limiting, which
 * has its own dedicated coverage in rate-limit.test.ts.
 */
export async function clearRateLimits(): Promise<void> {
  const keys = await coordRedis.keys('rl:*');
  if (keys.length > 0) await coordRedis.del(...keys);
}
