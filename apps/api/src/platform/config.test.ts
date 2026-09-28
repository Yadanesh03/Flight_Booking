import { describe, expect, it } from 'vitest';
import { HOLD_TTL_SECONDS, PENDING_BOOKING_STALE_SECONDS } from '@flight/shared';
import { loadConfig } from './config.js';

const base = { DATABASE_URL: 'mysql://app:pw@localhost:3306/flight_booking' };

describe('loadConfig', () => {
  it('applies spec defaults', () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.port).toBe(8080);
    expect(cfg.redisCacheUrl).toBe('redis://localhost:6379');
    expect(cfg.redisCoordUrl).toBe('redis://localhost:6380');
    expect(cfg.allowedOrigin).toBe('http://localhost:5173');
    expect(cfg.cookieSecure).toBe(false);
    expect(cfg.trustProxy).toBe(false);
    expect(cfg.holdTtlSeconds).toBe(HOLD_TTL_SECONDS);
    expect(cfg.pendingBookingStaleSeconds).toBe(PENDING_BOOKING_STALE_SECONDS);
  });

  it('rejects a missing or non-mysql DATABASE_URL, listing every problem', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x/y' })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...base, PORT: 'abc', COOKIE_SECURE: 'maybe' })).toThrow(/PORT[\s\S]*COOKIE_SECURE/);
  });

  it('honours HOLD_TTL_SECONDS and PENDING_BOOKING_STALE_SECONDS only when NODE_ENV=test', () => {
    const overrides = { HOLD_TTL_SECONDS: '3', PENDING_BOOKING_STALE_SECONDS: '2' };
    const test = loadConfig({ ...base, ...overrides, NODE_ENV: 'test' });
    expect(test.holdTtlSeconds).toBe(3);
    expect(test.pendingBookingStaleSeconds).toBe(2);
    expect(test.isTest).toBe(true);
    for (const nodeEnv of ['development', 'production'] as const) {
      const cfg = loadConfig({ ...base, ...overrides, NODE_ENV: nodeEnv });
      expect(cfg.holdTtlSeconds, nodeEnv).toBe(HOLD_TTL_SECONDS);
      expect(cfg.pendingBookingStaleSeconds, nodeEnv).toBe(PENDING_BOOKING_STALE_SECONDS);
    }
  });

  it('rejects a non-positive test override', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'test', HOLD_TTL_SECONDS: '0' })).toThrow(/HOLD_TTL_SECONDS/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'test', HOLD_TTL_SECONDS: '1.5' })).toThrow(/HOLD_TTL_SECONDS/);
  });

  it('treats empty optional values as unset', () => {
    const cfg = loadConfig({ ...base, SERVE_STATIC_DIR: '', SEED_ADMIN_EMAIL: '  ' });
    expect(cfg.serveStaticDir).toBeUndefined();
    expect(cfg.seedAdminEmail).toBeUndefined();
  });

  it('normalises ALLOWED_ORIGIN to a bare origin', () => {
    expect(loadConfig({ ...base, ALLOWED_ORIGIN: 'http://localhost:5173/' }).allowedOrigin).toBe('http://localhost:5173');
    expect(loadConfig({ ...base, ALLOWED_ORIGIN: 'https://app.example.com/some/path' }).allowedOrigin).toBe(
      'https://app.example.com'
    );
  });

  it('parses booleans case-insensitively', () => {
    const cfg = loadConfig({ ...base, COOKIE_SECURE: 'TRUE', TRUST_PROXY: ' true ' });
    expect(cfg.cookieSecure).toBe(true);
    expect(cfg.trustProxy).toBe(true);
  });
});
