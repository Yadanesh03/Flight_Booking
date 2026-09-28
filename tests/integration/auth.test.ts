import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_ABSOLUTE_MAX_SECONDS, SESSION_IDLE_TTL_SECONDS } from '@flight/shared';
import { coordRedis } from '../../apps/api/src/platform/redis.js';
import { ORIGIN, client, resetState, startTestApp, stopTestApp } from './helpers/testApp.js';

let app: Express;

beforeAll(async () => {
  app = await startTestApp();
});
afterAll(stopTestApp);
beforeEach(resetState);

const valid = { name: 'Asha Rao', email: 'asha@example.com', password: 'correct horse battery' };

function sidFrom(setCookie: string[] | string | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
  const match = /(?:^|;\s*)sid=([^;]+)/.exec(header.find((c) => c.startsWith('sid=')) ?? '');
  if (!match?.[1]) throw new Error(`no sid cookie in ${JSON.stringify(setCookie)}`);
  return match[1];
}

const sessionKey = (sid: string): string => `auth:sess:${createHash('sha256').update(sid).digest('hex')}`;

describe('POST /api/auth/register', () => {
  it('creates the user, sets a hardened session cookie, and never returns the password hash', async () => {
    const res = await client(app).post('/api/auth/register').send(valid);
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ name: 'Asha Rao', email: 'asha@example.com', role: 'USER' });
    expect(res.body.user.id).toBeTypeOf('number');
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);

    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('sid='))!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Max-Age=${SESSION_ABSOLUTE_MAX_SECONDS}`);
    expect(cookie).not.toContain('Secure'); // COOKIE_SECURE=false in the test environment
  });

  it('lowercases and trims the email; duplicates (any case) return 409 EMAIL_TAKEN', async () => {
    const first = await client(app).post('/api/auth/register').send({ ...valid, email: '  ASHA@Example.COM ' });
    expect(first.status).toBe(201);
    expect(first.body.user.email).toBe('asha@example.com');

    const dup = await client(app).post('/api/auth/register').send({ ...valid, email: 'asha@example.com' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');
    expect(dup.body.requestId).toBeTypeOf('string');
  });

  it('validates input with 400 VALIDATION_ERROR', async () => {
    const cases: Array<Record<string, unknown>> = [
      { ...valid, password: 'short' },
      { ...valid, password: 'x'.repeat(73) },
      { ...valid, password: 'é'.repeat(37) }, // 37 chars but 74 bytes (> bcrypt's 72-byte limit)
      { ...valid, email: 'not-an-email' },
      { ...valid, name: '   ' },
      { ...valid, name: 'n'.repeat(101) },
      { email: valid.email }
    ];
    for (const body of cases) {
      const res = await client(app).post('/api/auth/register').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('rejects a malformed JSON body with 400 (not 500)', async () => {
    const res = await client(app).post('/api/auth/register').set('Content-Type', 'application/json').send('{"name":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('stores a bcrypt cost-12 hash and a hashed, TTL-bound session in redis-coord', async () => {
    const res = await client(app).post('/api/auth/register').send(valid);
    const sid = sidFrom(res.headers['set-cookie']);

    // Session is keyed by sha256(sid), never by the raw cookie value.
    const keys = await coordRedis.keys('auth:sess:*');
    expect(keys).toEqual([sessionKey(sid)]);
    expect(keys.some((k) => k.includes(sid))).toBe(false);

    const ttl = await coordRedis.ttl(sessionKey(sid));
    expect(ttl).toBeGreaterThan(SESSION_IDLE_TTL_SECONDS - 5);
    expect(ttl).toBeLessThanOrEqual(SESSION_IDLE_TTL_SECONDS);

    const record = JSON.parse((await coordRedis.get(sessionKey(sid)))!) as Record<string, unknown>;
    expect(record).toMatchObject({ userId: res.body.user.id, role: 'USER' });
    expect(record['createdAt']).toBeTypeOf('number');
    expect(record['lastSeenAt']).toBeTypeOf('number');

    const { db } = await import('../../apps/api/src/platform/db.js');
    const { sql } = await import('drizzle-orm');
    const [rows] = (await db.execute(sql`SELECT password_hash FROM users`)) as unknown as [Array<{ password_hash: string }>];
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$12\$/);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await client(app).post('/api/auth/register').send(valid);
  });

  it('logs in, and /me then returns the user', async () => {
    const c = client(app);
    const res = await c.post('/api/auth/login').send({ email: 'ASHA@example.com', password: valid.password });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('asha@example.com');

    const me = await c.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ email: 'asha@example.com', role: 'USER' });
  });

  it('gives the same 401 INVALID_CREDENTIALS for a wrong password and an unknown email', async () => {
    const wrongPassword = await client(app).post('/api/auth/login').send({ email: valid.email, password: 'nope-nope-nope' });
    const unknownEmail = await client(app).post('/api/auth/login').send({ email: 'ghost@example.com', password: 'nope-nope-nope' });
    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    }
    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
    expect(wrongPassword.headers['set-cookie']).toBeUndefined();
  });

  it('issues a NEW session id on login and invalidates the previous one (session fixation defence)', async () => {
    const first = await client(app).post('/api/auth/login').send({ email: valid.email, password: valid.password });
    const oldSid = sidFrom(first.headers['set-cookie']);

    const c = client(app);
    const second = await c
      .post('/api/auth/login')
      .set('Cookie', `sid=${oldSid}`)
      .send({ email: valid.email, password: valid.password });
    expect(second.status).toBe(200);
    const newSid = sidFrom(second.headers['set-cookie']);
    expect(newSid).not.toBe(oldSid);

    expect(await coordRedis.exists(sessionKey(oldSid))).toBe(0);
    expect(await coordRedis.exists(sessionKey(newSid))).toBe(1);
    const stale = await client(app).get('/api/auth/me').set('Cookie', `sid=${oldSid}`);
    expect(stale.status).toBe(401);
  });

  it('clears the failure counter on success', async () => {
    const emailHash = createHash('sha256').update(valid.email).digest('hex');
    await client(app).post('/api/auth/login').send({ email: valid.email, password: 'wrong-wrong-wrong' });
    expect(await coordRedis.get(`auth:loginfail:${emailHash}`)).toBe('1');
    await client(app).post('/api/auth/login').send({ email: valid.email, password: valid.password });
    expect(await coordRedis.exists(`auth:loginfail:${emailHash}`)).toBe(0);
  });
});

describe('logout and me', () => {
  it('logout returns 204, clears the cookie and destroys the server-side session', async () => {
    const c = client(app);
    const reg = await c.post('/api/auth/register').send(valid);
    const sid = sidFrom(reg.headers['set-cookie']);

    const out = await c.post('/api/auth/logout');
    expect(out.status).toBe(204);
    const cleared = (out.headers['set-cookie'] as unknown as string[]).find((h) => h.startsWith('sid='))!;
    expect(cleared).toMatch(/sid=;/);
    expect(await coordRedis.exists(sessionKey(sid))).toBe(0);

    // Even a client that kept the old cookie is now anonymous.
    const replay = await client(app).get('/api/auth/me').set('Cookie', `sid=${sid}`);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('protected routes answer 401 without a session, and ignore garbage cookies', async () => {
    expect((await client(app).get('/api/auth/me')).status).toBe(401);
    expect((await client(app).post('/api/auth/logout')).status).toBe(401);
    expect((await client(app).get('/api/auth/me').set('Cookie', 'sid=not-a-real-session')).status).toBe(401);
    expect((await client(app).get('/api/auth/me').set('Cookie', `sid=${'A'.repeat(43)}`)).status).toBe(401);
  });

  it('deletes the session and returns 401 when the user no longer exists', async () => {
    const c = client(app);
    const reg = await c.post('/api/auth/register').send(valid);
    const sid = sidFrom(reg.headers['set-cookie']);
    const { db } = await import('../../apps/api/src/platform/db.js');
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`DELETE FROM users`);

    const me = await c.get('/api/auth/me');
    expect(me.status).toBe(401);
    expect(await coordRedis.exists(sessionKey(sid))).toBe(0);
  });
});

describe('session lifetime', () => {
  async function registerAndGetSid(): Promise<{ sid: string; c: ReturnType<typeof client> }> {
    const c = client(app);
    const reg = await c.post('/api/auth/register').send(valid);
    return { sid: sidFrom(reg.headers['set-cookie']), c };
  }

  it('does not touch a fresh session, and refreshes lastSeenAt + TTL once it is older than 15 minutes', async () => {
    const { sid, c } = await registerAndGetSid();
    const key = sessionKey(sid);
    const before = JSON.parse((await coordRedis.get(key))!) as { lastSeenAt: number };
    await c.get('/api/auth/me');
    const untouched = JSON.parse((await coordRedis.get(key))!) as { lastSeenAt: number };
    expect(untouched.lastSeenAt).toBe(before.lastSeenAt);

    // Pretend it was last seen 20 minutes ago with only an hour of TTL left.
    const record = JSON.parse((await coordRedis.get(key))!) as Record<string, number>;
    await coordRedis.set(key, JSON.stringify({ ...record, lastSeenAt: Date.now() - 20 * 60_000 }), 'EX', 3600);
    await c.get('/api/auth/me');
    const touched = JSON.parse((await coordRedis.get(key))!) as { lastSeenAt: number };
    expect(touched.lastSeenAt).toBeGreaterThan(Date.now() - 5000);
    expect(await coordRedis.ttl(key)).toBeGreaterThan(SESSION_IDLE_TTL_SECONDS - 10);
  });

  it('caps the refreshed TTL at the remaining absolute lifetime', async () => {
    const { sid, c } = await registerAndGetSid();
    const key = sessionKey(sid);
    const record = JSON.parse((await coordRedis.get(key))!) as Record<string, number>;
    // Created 6 days 23 hours ago: only ~1 hour of the 7-day absolute lifetime remains.
    const createdAt = Date.now() - (SESSION_ABSOLUTE_MAX_SECONDS - 3600) * 1000;
    await coordRedis.set(key, JSON.stringify({ ...record, createdAt, lastSeenAt: createdAt }), 'EX', SESSION_IDLE_TTL_SECONDS);
    expect((await c.get('/api/auth/me')).status).toBe(200);
    const ttl = await coordRedis.ttl(key);
    expect(ttl).toBeLessThanOrEqual(3600);
    expect(ttl).toBeGreaterThan(3500);
  });

  it('rejects and deletes a session past its 7-day absolute lifetime, however recently it was used', async () => {
    const { sid, c } = await registerAndGetSid();
    const key = sessionKey(sid);
    const record = JSON.parse((await coordRedis.get(key))!) as Record<string, number>;
    const createdAt = Date.now() - (SESSION_ABSOLUTE_MAX_SECONDS + 60) * 1000;
    await coordRedis.set(key, JSON.stringify({ ...record, createdAt, lastSeenAt: Date.now() }), 'EX', SESSION_IDLE_TTL_SECONDS);
    expect((await c.get('/api/auth/me')).status).toBe(401);
    expect(await coordRedis.exists(key)).toBe(0);
  });

  it('a corrupted session record is treated as anonymous and removed', async () => {
    const { sid, c } = await registerAndGetSid();
    await coordRedis.set(sessionKey(sid), 'not json', 'EX', 100);
    expect((await c.get('/api/auth/me')).status).toBe(401);
    expect(await coordRedis.exists(sessionKey(sid))).toBe(0);
  });
});

describe('origin check (spec test 24)', () => {
  it('rejects a POST from a foreign Origin with 403 FORBIDDEN, before any handler runs', async () => {
    const res = await client(app, 'https://evil.example').post('/api/auth/register').send(valid);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    const { db } = await import('../../apps/api/src/platform/db.js');
    const { sql } = await import('drizzle-orm');
    const [rows] = (await db.execute(sql`SELECT COUNT(*) AS n FROM users`)) as unknown as [Array<{ n: number }>];
    expect(Number(rows[0].n)).toBe(0);
  });

  it('rejects look-alike origins and the literal "null" origin', async () => {
    for (const origin of ['http://localhost:5173.evil.example', 'http://localhost:5174', 'https://localhost:5173', 'null']) {
      const res = await client(app, origin).post('/api/auth/register').send(valid);
      expect(res.status, origin).toBe(403);
    }
  });

  it('rejects mutating requests with no Origin and no Referer', async () => {
    const res = await client(app, null).post('/api/auth/register').send(valid);
    expect(res.status).toBe(403);
  });

  it('falls back to the Referer origin when Origin is absent', async () => {
    const ok = await client(app, null).post('/api/auth/register').set('Referer', `${ORIGIN}/register`).send(valid);
    expect(ok.status).toBe(201);
    const bad = await client(app, null)
      .post('/api/auth/register')
      .set('Referer', 'https://evil.example/register')
      .send({ ...valid, email: 'other@example.com' });
    expect(bad.status).toBe(403);
  });

  it('does not restrict safe methods', async () => {
    const res = await client(app, null).get('/api/auth/me');
    expect(res.status).toBe(401); // reached the route (401), not blocked by the origin check (403)
  });

  it('also protects PUT, PATCH and DELETE', async () => {
    for (const method of ['put', 'patch', 'delete'] as const) {
      const res = await client(app, 'https://evil.example')[method]('/api/anything');
      expect(res.status, method).toBe(403);
    }
  });
});

describe('request id and error model', () => {
  it('echoes a valid UUID X-Request-Id and replaces an invalid one', async () => {
    const id = '3f0c1f0e-8f3b-4a55-9d0a-0d5d7a5b9f11';
    const good = await client(app).get('/api/auth/me').set('X-Request-Id', id);
    expect(good.headers['x-request-id']).toBe(id);
    expect(good.body.requestId).toBe(id);

    // (A header containing a newline cannot even be sent by Node's HTTP client, so use values that can.)
    for (const invalid of ['not-a-uuid', '<script>alert(1)</script>', `${id}-extra`]) {
      const bad = await client(app).get('/api/auth/me').set('X-Request-Id', invalid);
      expect(bad.headers['x-request-id'], invalid).toMatch(/^[0-9a-f-]{36}$/);
      expect(bad.headers['x-request-id'], invalid).not.toBe(invalid);
      expect(bad.body.requestId).toBe(bad.headers['x-request-id']);
    }
  });

  it('returns the documented error shape for unknown API routes and never leaks stack traces', async () => {
    const res = await client(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: 'NOT_FOUND', message: expect.any(String) }, requestId: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.(ts|js):\d+/);
  });
});

describe('health endpoints', () => {
  it('/health is 200 and /ready is 200 with every dependency ok', async () => {
    expect((await client(app).get('/health')).body).toEqual({ status: 'ok' });
    const ready = await client(app).get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.dependencies).toEqual({ mysql: 'ok', redisCache: 'ok', redisCoord: 'ok' });
  });
});
