import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const rootDir = import.meta.dirname;
const envFile = resolve(rootDir, '.env');
// Load the developer's local .env (git-ignored) so tests use the same host/ports as `npm run dev`.
if (existsSync(envFile)) process.loadEnvFile(envFile);

const defaultDbUrl = 'mysql://app:app_dev_password@localhost:3306/flight_booking';

/** Integration tests always run against the separate `flight_booking_test` database. */
function testDatabaseUrl(): string {
  if (process.env['TEST_DATABASE_URL']) return process.env['TEST_DATABASE_URL'];
  const url = new URL(process.env['DATABASE_URL'] ?? defaultDbUrl);
  url.pathname = '/flight_booking_test';
  return url.toString();
}

/**
 * Tests use logical Redis database 1 so flushing between tests can never wipe a developer's
 * dev-server sessions/caches (which live in database 0).
 */
function testRedisUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/1';
  return parsed.toString();
}

const testEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  PORT: '0',
  DATABASE_URL: testDatabaseUrl(),
  REDIS_CACHE_URL: testRedisUrl(process.env['REDIS_CACHE_URL'] ?? 'redis://localhost:6379'),
  REDIS_COORD_URL: testRedisUrl(process.env['REDIS_COORD_URL'] ?? 'redis://localhost:6380'),
  ALLOWED_ORIGIN: 'http://localhost:5173',
  COOKIE_SECURE: 'false',
  TRUST_PROXY: 'false',
  HOLD_TTL_SECONDS: '3',
  PENDING_BOOKING_STALE_SECONDS: '2'
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['apps/api/src/**/*.test.ts', 'packages/shared/src/**/*.test.ts', 'tests/unit/**/*.test.ts'],
          env: testEnv
        }
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          env: testEnv,
          // One shared MySQL database and two shared Redis instances: run test files one at a time.
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 60_000,
          hookTimeout: 60_000
        }
      }
    ]
  }
});
