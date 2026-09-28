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
  await resetState();
  return app;
}

export async function stopTestApp(): Promise<void> {
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
 * like a browser on the SPA's origin would.
 */
export function client(app: Express, origin: string | null = ORIGIN) {
  const agent = supertest.agent(app);
  const withOrigin = (test: supertest.Test): supertest.Test => (origin === null ? test : test.set('Origin', origin));
  return {
    agent,
    get: (path: string) => agent.get(path),
    post: (path: string) => withOrigin(agent.post(path)),
    put: (path: string) => withOrigin(agent.put(path)),
    patch: (path: string) => withOrigin(agent.patch(path)),
    delete: (path: string) => withOrigin(agent.delete(path))
  };
}

export type TestClient = ReturnType<typeof client>;
