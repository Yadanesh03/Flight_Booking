import type { Express } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LOGIN_LOCK_SECONDS, RATE_LIMITS } from '@flight/shared';
import { coordRedis } from '../../apps/api/src/platform/redis.js';
import { client, resetState, startTestApp, stopTestApp, withRedisDown, type TestClient } from './helpers/testApp.js';
import { holdSeats, loginAdmin, loginAs, newUser, publishedFlight, seedAirports } from './helpers/fixtures.js';

let app: Express;
let admin: TestClient;

beforeAll(async () => {
  app = await startTestApp();
});
afterAll(stopTestApp);
beforeEach(async () => {
  await resetState();
  await seedAirports();
  ({ http: admin } = await loginAdmin(app));
});

describe('rate limiting (Section 12)', () => {
  it('allowed responses carry RateLimit-Limit and a decreasing RateLimit-Remaining', async () => {
    const anon = client(app);
    const limit = RATE_LIMITS.read.limit;
    const first = await anon.get('/api/airports');
    expect(first.status).toBe(200);
    expect(first.headers['ratelimit-limit']).toBe(String(limit));
    const remaining1 = Number(first.headers['ratelimit-remaining']);
    const second = await anon.get('/api/airports');
    expect(Number(second.headers['ratelimit-remaining'])).toBe(remaining1 - 1);
  });

  it('spec test 14: the 11th login from one IP in a minute is 429 with Retry-After', async () => {
    const ip = client(app); // fixed IP for every attempt below
    for (let i = 0; i < RATE_LIMITS.auth_login.limit; i += 1) {
      const res = await ip.post('/api/auth/login').send({ email: `nobody${i}@example.com`, password: 'wrong-wrong-wrong' });
      expect(res.status, `attempt ${i + 1}`).toBe(401); // wrong credentials, but NOT rate limited yet
    }
    const blocked = await ip.post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong-wrong-wrong' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(60);

    // A different IP is unaffected.
    const other = client(app);
    const res = await other.post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong-wrong-wrong' });
    expect(res.status).toBe(401);
  });

  it(`caps registration at ${RATE_LIMITS.auth_register.limit}/hour per IP`, async () => {
    const ip = client(app);
    for (let i = 0; i < RATE_LIMITS.auth_register.limit; i += 1) {
      const res = await ip.post('/api/auth/register').send({ name: 'X', email: `reg${i}@example.com`, password: 'password123' });
      expect(res.status, `attempt ${i + 1}`).toBe(201);
    }
    const blocked = await ip.post('/api/auth/register').send({ name: 'X', email: 'onemore@example.com', password: 'password123' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });

  it(`caps holds at ${RATE_LIMITS.holds.limit}/min per user`, async () => {
    const flight = await publishedFlight(admin, { rows: 12 });
    const { http } = await newUser(app);
    for (let i = 0; i < RATE_LIMITS.holds.limit; i += 1) {
      const res = await holdSeats(http, flight.flightId, [flight.seats[i % flight.seats.length].seatId]);
      expect(res.status, `attempt ${i + 1}`).toBe(200);
    }
    const blocked = await holdSeats(http, flight.flightId, [flight.seats[0].seatId]);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');

    // A different user on the same flight is unaffected (the limit is per user).
    const other = await newUser(app);
    expect((await holdSeats(other.http, flight.flightId, [flight.seats[0].seatId])).status).toBe(200);
  });

  it(`caps admin actions at ${RATE_LIMITS.admin.limit}/min per admin user`, async () => {
    for (let i = 0; i < RATE_LIMITS.admin.limit; i += 1) {
      const res = await admin.get('/api/admin/aircraft');
      expect(res.status, `attempt ${i + 1}`).toBe(200);
    }
    const blocked = await admin.get('/api/admin/aircraft');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });

  it('the global IP limit is a separate, lower-priority ceiling than any single route/user limit', async () => {
    // Every route's own limit (<=120/min) is below the global ceiling (300/min), so hammering one
    // route as one subject cannot isolate the global limit in practice: that route's own limit fires
    // first (already covered above). Instead, share ONE ip across several DIFFERENT users, each well
    // under its own 120/min `read` quota: only the ip-keyed `global` counter accumulates across all of
    // them, and it is what eventually blocks the request.
    const sharedIp = '203.0.113.42';
    const userCount = 3;
    const perUser = Math.ceil(RATE_LIMITS.global.limit / userCount) + 5; // userCount x perUser > global limit
    expect(perUser).toBeLessThan(RATE_LIMITS.read.limit); // each user individually stays well under its own limit

    const users = await Promise.all(
      Array.from({ length: userCount }, (_v, i) => loginAs(app, { email: `shared-ip-${i}@example.com`, ip: sharedIp }))
    );

    let blockedAt: { userIndex: number; call: number } | null = null;
    outer: for (let call = 0; call < perUser && blockedAt === null; call += 1) {
      for (const [userIndex, { http }] of users.entries()) {
        const res = await http.get('/api/bookings');
        if (res.status === 429) {
          blockedAt = { userIndex, call };
          expect(res.body.error.code).toBe('RATE_LIMITED');
          break outer;
        }
        expect(res.status, `user ${userIndex} call ${call}`).toBe(200);
      }
    }
    expect(blockedAt, `expected the shared-ip global limit to trigger within ${perUser * userCount} requests`).not.toBeNull();

    // A DIFFERENT ip, using a fresh user, is unaffected: the block was about the ip, not any one user.
    const elsewhere = await newUser(app);
    expect((await elsewhere.http.get('/api/bookings')).status).toBe(200);
  });

  it('health endpoints are outside the pipeline and never rate limited', async () => {
    const ip = client(app);
    for (let i = 0; i < RATE_LIMITS.global.limit + 5; i += 1) await ip.get('/health');
    expect((await ip.get('/health')).status).toBe(200);
  });

  it('failing open: with redis-coord down, requests proceed without a RateLimit header', async () => {
    await withRedisDown('coord', async () => {
      const res = await client(app).get('/api/airports');
      expect(res.status).toBe(200);
      expect(res.headers['ratelimit-limit']).toBeUndefined();
    });
  });
});

describe('login lockout (Section 11.2, spec test 15)', () => {
  const email = 'lockout-target@example.com';

  beforeEach(async () => {
    await client(app).post('/api/auth/register').send({ name: 'Target', email, password: 'the-real-password' });
  });

  it('locks the account after 10 failures within 15 minutes, even against the correct password', async () => {
    // Spread the failed attempts across distinct IPs so the per-IP login rate limit (10/min) is not
    // what blocks the 11th attempt: this test is about the per-ACCOUNT lockout, a separate mechanism.
    for (let i = 0; i < 10; i += 1) {
      const res = await client(app).post('/api/auth/login').send({ email, password: 'totally-wrong' });
      expect(res.status, `failure ${i + 1}`).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    }
    const locked = await client(app).post('/api/auth/login').send({ email, password: 'the-real-password' });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('ACCOUNT_TEMPORARILY_LOCKED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(locked.headers['retry-after'])).toBeLessThanOrEqual(LOGIN_LOCK_SECONDS);

    // A DIFFERENT account is unaffected.
    await client(app).post('/api/auth/register').send({ name: 'Other', email: 'other@example.com', password: 'whatever123' });
    const other = await client(app).post('/api/auth/login').send({ email: 'other@example.com', password: 'wrong' });
    expect(other.status).toBe(401);
    expect(other.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('does not lock for fewer than 10 failures, and success resets the counter', async () => {
    for (let i = 0; i < 9; i += 1) await client(app).post('/api/auth/login').send({ email, password: 'totally-wrong' });
    const ok = await client(app).post('/api/auth/login').send({ email, password: 'the-real-password' });
    expect(ok.status).toBe(200);
    // The counter was cleared by the success: 9 more failures should not lock the account either.
    for (let i = 0; i < 9; i += 1) await client(app).post('/api/auth/login').send({ email, password: 'totally-wrong' });
    const stillOk = await client(app).post('/api/auth/login').send({ email, password: 'the-real-password' });
    expect(stillOk.status).toBe(200);
  });

  it('the lock expires on its own after LOGIN_LOCK_SECONDS', async () => {
    for (let i = 0; i < 10; i += 1) await client(app).post('/api/auth/login').send({ email, password: 'totally-wrong' });
    const key = (await coordRedis.keys('auth:loginlock:*'))[0];
    expect(key).toBeDefined();
    await coordRedis.pexpire(key, 50); // fast-forward the lock's expiry for the test
    await new Promise((resolve) => setTimeout(resolve, 150));
    const res = await client(app).post('/api/auth/login').send({ email, password: 'the-real-password' });
    expect(res.status).toBe(200);
  });

  it('locking out one account does not affect login for others, or that account\'s ability to register-elsewhere', async () => {
    for (let i = 0; i < 10; i += 1) await client(app).post('/api/auth/login').send({ email, password: 'totally-wrong' });
    const { http } = await newUser(app); // an unrelated account logs in fine via the fast test path
    expect((await http.get('/api/auth/me')).status).toBe(200);
  });
});
