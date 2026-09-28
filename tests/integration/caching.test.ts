import type { Express } from 'express';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CACHE_TTL_JITTER, CACHE_TTL_SECONDS, FILL_WAIT_MAX_MS, NEGATIVE_CACHE_SENTINEL } from '@flight/shared';
import { db } from '../../apps/api/src/platform/db.js';
import { cacheRedis, coordRedis } from '../../apps/api/src/platform/redis.js';
import { setTestHook } from '../../apps/api/src/platform/testSupport.js';
import { client, resetState, startTestApp, stopTestApp, withRedisDown, type TestClient } from './helpers/testApp.js';
import {
  book,
  bookingBody,
  createGate,
  indiaDate,
  indiaTime,
  loginAdmin,
  newUser,
  publishedFlight,
  scalar,
  seedAirports,
  sleep,
  type PublishedFlight
} from './helpers/fixtures.js';

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

const stats = async (): Promise<{ dbQueries: { flightById: number; seatStatus: number }; paymentCalls: number }> =>
  (await client(app).get('/api/_test/stats')).body;
const resetStats = () => client(app).post('/api/_test/reset');

/** Asserts a TTL is within +/- the jitter band (plus a little slack for elapsed time). */
function expectTtlAround(ttl: number, base: number): void {
  const low = Math.round(base * (1 - CACHE_TTL_JITTER)) - 5;
  const high = Math.round(base * (1 + CACHE_TTL_JITTER));
  expect(ttl, `ttl ${ttl} not within [${low}, ${high}]`).toBeGreaterThanOrEqual(low);
  expect(ttl, `ttl ${ttl} not within [${low}, ${high}]`).toBeLessThanOrEqual(high);
}

describe('test-mode counters (Section 19.4)', () => {
  it('expose and reset query counters, and exist only in NODE_ENV=test', async () => {
    const flight = await publishedFlight(admin);
    await client(app).get(`/api/flights/${flight.flightId}`);
    expect((await stats()).dbQueries.flightById).toBe(1);
    expect((await resetStats()).status).toBe(204);
    expect(await stats()).toEqual({ dbQueries: { flightById: 0, seatStatus: 0 }, paymentCalls: 0 });
  });
});

describe('spec test 11: flight-details stampede', () => {
  it('200 concurrent GETs on a cold cache cost exactly one database query', async () => {
    const flight = await publishedFlight(admin);
    await cacheRedis.flushdb(); // cold cache (redis-coord is left alone: it holds the test users' sessions)
    await resetStats();

    const responses = await Promise.all(Array.from({ length: 200 }, () => client(app).get(`/api/flights/${flight.flightId}`)));
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.flight.flightId).toBe(flight.flightId);
    }
    expect((await stats()).dbQueries.flightById).toBe(1);

    // and afterwards it is served from the cache
    await client(app).get(`/api/flights/${flight.flightId}`);
    expect((await stats()).dbQueries.flightById).toBe(1);
    expect(await coordRedis.keys('lock:fill:*')).toEqual([]); // the fill lock was released
  });

  it('a missing flight is negatively cached (30 s) so a hot 404 cannot hammer the database', async () => {
    await resetStats();
    const responses = await Promise.all(Array.from({ length: 100 }, () => client(app).get('/api/flights/424242')));
    for (const res of responses) expect(res.status).toBe(404);
    expect((await stats()).dbQueries.flightById).toBe(1);

    await client(app).get('/api/flights/424242');
    expect((await stats()).dbQueries.flightById).toBe(1);
    expect(await cacheRedis.get('fs:flight:424242')).toBe(NEGATIVE_CACHE_SENTINEL);
    expectTtlAround(await cacheRedis.ttl('fs:flight:424242'), CACHE_TTL_SECONDS.negative);
  });
});

describe('spec test 12: seat-map stampede', () => {
  it('200 concurrent seat-map GETs on a cold cache cost exactly one seat-status query', async () => {
    const flight = await publishedFlight(admin);
    await cacheRedis.flushdb(); // cold cache (redis-coord is left alone: it holds the test users' sessions)
    await resetStats();

    const responses = await Promise.all(Array.from({ length: 200 }, () => client(app).get(`/api/flights/${flight.flightId}/seats`)));
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.seats).toHaveLength(36);
    }
    expect((await stats()).dbQueries.seatStatus).toBe(1);

    // The status hash now holds every seat, with a jittered 600 s TTL.
    expect(await cacheRedis.hlen(`bs:seats:${flight.flightId}`)).toBe(36);
    expectTtlAround(await cacheRedis.ttl(`bs:seats:${flight.flightId}`), CACHE_TTL_SECONDS.seatStatus);
    expectTtlAround(await cacheRedis.ttl(`bs:seatmeta:${flight.flightId}`), CACHE_TTL_SECONDS.seatMeta);

    await client(app).get(`/api/flights/${flight.flightId}/seats`);
    expect((await stats()).dbQueries.seatStatus).toBe(1);
    expect(await coordRedis.keys('lock:fill:*')).toEqual([]);
  });
});

describe('spec test 13: a slow seat-status fill racing a booking commit', () => {
  async function seatMap(flight: PublishedFlight) {
    return client(app).get(`/api/flights/${flight.flightId}/seats`);
  }
  const statusOf = (body: { seats: Array<{ seatNumber: string; status: string }> }, seatNumber: string) =>
    body.seats.find((s) => s.seatNumber === seatNumber)?.status;

  it('the stale fill is refused, and the cache shows BOOKED afterwards', async () => {
    const flight = await publishedFlight(admin);
    const seat = flight.seat('2A');
    const { http } = await newUser(app);
    await cacheRedis.flushdb(); // cold cache (redis-coord is left alone: it holds the test users' sessions)

    // The fill reads the version and MySQL (seat still available), then pauses at a gate that only this
    // test opens: no sleeps, so the interleaving is identical on a fast or a loaded machine.
    const gate = createGate();
    setTestHook('seatFillAfterDbRead', gate.hook);
    const slowFill = seatMap(flight).then((r) => r);
    await gate.reached;

    // While it is paused, a booking for that seat commits and bumps the version.
    const booked = await book(http, bookingBody(flight.flightId, [{ seatId: seat.seatId }]));
    expect(booked.status).toBe(201);
    expect(await cacheRedis.get(`bs:seatsver:${flight.flightId}`)).toBe('1');

    // The paused fill resumes: its caller still gets its (older) snapshot...
    gate.release();
    const first = await slowFill;
    expect(first.status).toBe(200);
    expect(statusOf(first.body, '2A')).toBe('AVAILABLE');
    // ...but the stale snapshot was NOT written to the cache.
    expect(await cacheRedis.exists(`bs:seats:${flight.flightId}`)).toBe(0);

    // The next read fills from MySQL's truth.
    setTestHook('seatFillAfterDbRead', () => undefined);
    const second = await seatMap(flight);
    expect(statusOf(second.body, '2A')).toBe('BOOKED');
    expect(await cacheRedis.hget(`bs:seats:${flight.flightId}`, String(seat.seatId))).toBe('B');
    expect(await cacheRedis.hlen(`bs:seats:${flight.flightId}`)).toBe(36);
  });

  it('control: with no booking in between, the slow fill IS written', async () => {
    const flight = await publishedFlight(admin);
    await cacheRedis.flushdb(); // cold cache (redis-coord is left alone: it holds the test users' sessions)
    let stalled = false;
    setTestHook('seatFillAfterDbRead', async () => {
      if (stalled) return;
      stalled = true;
      await sleep(300);
    });
    const res = await seatMap(flight);
    expect(res.status).toBe(200);
    expect(await cacheRedis.hlen(`bs:seats:${flight.flightId}`)).toBe(36);
  });

  it('a committed booking writes through: the cached hash marks the seat B immediately', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    await seatMap(flight); // fills the cache
    expect(await cacheRedis.hget(`bs:seats:${flight.flightId}`, String(flight.seat('3A').seatId))).toBe('A');
    await book(http, bookingBody(flight.flightId, [{ seatId: flight.seat('3A').seatId }]));
    expect(await cacheRedis.hget(`bs:seats:${flight.flightId}`, String(flight.seat('3A').seatId))).toBe('B');
    expect(await cacheRedis.get(`bs:seatsver:${flight.flightId}`)).toBe('1');
    expectTtlAround(await cacheRedis.ttl(`bs:seatsver:${flight.flightId}`), CACHE_TTL_SECONDS.seatStatusVersion);
    const res = await seatMap(flight);
    expect(statusOf(res.body, '3A')).toBe('BOOKED');
  });

  it('a failed booking whose seats MySQL reports BOOKED repairs a stale cache', async () => {
    const flight = await publishedFlight(admin);
    const seat = flight.seat('2A').seatId;
    const first = await newUser(app);
    const second = await newUser(app);
    await seatMap(flight);
    // Simulate a commit whose cache update was lost (the process died right after COMMIT).
    await db.execute(sql`UPDATE flight_seats SET status = 'BOOKED' WHERE id = ${seat}`);
    expect(await cacheRedis.hget(`bs:seats:${flight.flightId}`, String(seat))).toBe('A'); // stale

    const res = await book(second.http, bookingBody(flight.flightId, [{ seatId: seat }]));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SEAT_UNAVAILABLE');
    expect(await cacheRedis.hget(`bs:seats:${flight.flightId}`, String(seat))).toBe('B'); // repaired
    void first;
  });
});

describe('spec test 19: redis-cache down', () => {
  it('search, details, seat map and a full booking all work through MySQL', async () => {
    const day = indiaDate(2);
    const flight = await publishedFlight(admin, { departureTime: indiaTime(day, 11) });
    const { http } = await newUser(app);

    await withRedisDown('cache', async () => {
      expect((await client(app).get('/api/airports')).body.airports.length).toBeGreaterThan(0);
      const search = await client(app).get(`/api/flights?from=BOM&to=DEL&date=${day}`);
      expect(search.status).toBe(200);
      expect(search.body.flights.map((f: { flightId: number }) => f.flightId)).toEqual([flight.flightId]);
      expect((await client(app).get(`/api/flights/${flight.flightId}`)).status).toBe(200);
      const map = await client(app).get(`/api/flights/${flight.flightId}/seats`);
      expect(map.status).toBe(200);
      expect(map.body.seats).toHaveLength(36);
      expect((await client(app).get('/api/flights/424242')).status).toBe(404);

      const res = await book(http, bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }]));
      expect(res.status).toBe(201); // the post-commit cache update failed, but never affects the response
      expect((await http.get('/api/bookings')).body.items).toHaveLength(1);
    });

    // redis-cache has no persistence, so a restarted instance comes back empty: MySQL's truth is served.
    await cacheRedis.flushdb();
    const map = await client(app).get(`/api/flights/${flight.flightId}/seats`);
    expect(map.body.seats.find((s: { seatNumber: string }) => s.seatNumber === '2A').status).toBe('BOOKED');
  });

  it('coalescing still applies while the cache is down (singleflight): a 100-request burst costs a handful of queries, not 100', async () => {
    const flight = await publishedFlight(admin);
    await resetStats();
    await withRedisDown('cache', async () => {
      const responses = await Promise.all(Array.from({ length: 100 }, () => client(app).get(`/api/flights/${flight.flightId}`)));
      for (const res of responses) expect(res.status).toBe(200);
    });
    // Singleflight shares one in-flight load among CONCURRENT callers; requests that arrive after it has
    // finished start a new one, so the exact count depends on timing. Without coalescing it would be 100.
    const queries = (await stats()).dbQueries.flightById;
    expect(queries).toBeGreaterThanOrEqual(1);
    expect(queries).toBeLessThanOrEqual(15);
  });

  it('a stale cache after a lost update is bounded: the booking path always trusts MySQL', async () => {
    const flight = await publishedFlight(admin);
    const seat = flight.seat('4A');
    const first = await newUser(app);
    const second = await newUser(app);
    await client(app).get(`/api/flights/${flight.flightId}/seats`); // hash cached: seat available

    await withRedisDown('cache', async () => {
      expect((await book(first.http, bookingBody(flight.flightId, [{ seatId: seat.seatId }]))).status).toBe(201);
    });
    // Cache is back but missed the update: the seat map still (wrongly) offers the seat...
    const stale = await client(app).get(`/api/flights/${flight.flightId}/seats`);
    expect(stale.body.seats.find((s: { seatNumber: string }) => s.seatNumber === '4A').status).toBe('AVAILABLE');
    // ...but nobody can actually book it twice, and the failed attempt repairs the cache.
    const second409 = await book(second.http, bookingBody(flight.flightId, [{ seatId: seat.seatId }]));
    expect(second409.status).toBe(409);
    const repaired = await client(app).get(`/api/flights/${flight.flightId}/seats`);
    expect(repaired.body.seats.find((s: { seatNumber: string }) => s.seatNumber === '4A').status).toBe('BOOKED');
  });
});

describe('redis-coord down: public reads keep working (distributed lock skipped, search cache bypassed)', () => {
  it('serves airports, search, details and the seat map', async () => {
    const day = indiaDate(2);
    const flight = await publishedFlight(admin, { departureTime: indiaTime(day, 12) });
    await withRedisDown('coord', async () => {
      expect((await client(app).get('/api/airports')).status).toBe(200);
      const search = await client(app).get(`/api/flights?from=BOM&to=DEL&date=${day}`);
      expect(search.status).toBe(200);
      expect(search.body.flights).toHaveLength(1);
      expect((await client(app).get(`/api/flights/${flight.flightId}`)).status).toBe(200);
      expect((await client(app).get(`/api/flights/${flight.flightId}/seats`)).status).toBe(200);
    });
  });
});

describe('fill lock behaviour', () => {
  it('a request that loses the lock returns the winner\'s value once it appears in the cache', async () => {
    const flight = await publishedFlight(admin);
    const key = `fs:flight:${flight.flightId}`;
    await client(app).get(`/api/flights/${flight.flightId}`);
    const real = JSON.parse((await cacheRedis.get(key))!) as Record<string, unknown>;
    await cacheRedis.del(key);

    // Someone else holds the fill lock...
    await coordRedis.set(`lock:fill:${key}`, 'some-other-instance', 'PX', 5000, 'NX');
    await resetStats();
    // ...and writes the value 300 ms later.
    setTimeout(() => void cacheRedis.set(key, JSON.stringify({ ...real, flightNumber: 'ZZ-999' }), 'EX', 60), 300);
    const res = await client(app).get(`/api/flights/${flight.flightId}`);
    expect(res.status).toBe(200);
    expect(res.body.flight.flightNumber).toBe('ZZ-999'); // it waited for, and used, the winner's value
    expect((await stats()).dbQueries.flightById).toBe(0); // and never touched the database
    // The lock we did not own is untouched.
    expect(await coordRedis.get(`lock:fill:${key}`)).toBe('some-other-instance');
  });

  it(`gives up after ${FILL_WAIT_MAX_MS} ms, reads MySQL directly and does NOT write the cache`, async () => {
    const flight = await publishedFlight(admin);
    const key = `fs:flight:${flight.flightId}`;
    await cacheRedis.del(key);
    await coordRedis.set(`lock:fill:${key}`, 'crashed-instance', 'PX', 10_000, 'NX'); // a holder that never finishes
    await resetStats();

    const started = Date.now();
    const res = await client(app).get(`/api/flights/${flight.flightId}`);
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    expect(res.body.flight.flightId).toBe(flight.flightId);
    expect(elapsed).toBeGreaterThanOrEqual(FILL_WAIT_MAX_MS - 100);
    expect(elapsed).toBeLessThan(FILL_WAIT_MAX_MS + 4000); // generous: only the lower bound is a guarantee
    expect((await stats()).dbQueries.flightById).toBe(1);
    expect(await cacheRedis.exists(key)).toBe(0);
  });

  it('an expired fill lock (crashed holder) is simply re-acquired by the next request', async () => {
    const flight = await publishedFlight(admin);
    const key = `fs:flight:${flight.flightId}`;
    await cacheRedis.del(key);
    await coordRedis.set(`lock:fill:${key}`, 'crashed-instance', 'PX', 150, 'NX');
    await sleep(250);
    const res = await client(app).get(`/api/flights/${flight.flightId}`);
    expect(res.status).toBe(200);
    expect(await cacheRedis.exists(key)).toBe(1);
  });
});

describe('TTLs and invalidation', () => {
  it('every cache entry has a jittered TTL from the constants', async () => {
    const day = indiaDate(2);
    const flight = await publishedFlight(admin, { departureTime: indiaTime(day, 9) });
    await client(app).get('/api/airports');
    await client(app).get(`/api/flights?from=BOM&to=DEL&date=${day}`);
    await client(app).get(`/api/flights/${flight.flightId}`);
    await client(app).get(`/api/flights/${flight.flightId}/seats`);

    expectTtlAround(await cacheRedis.ttl('fs:airports'), CACHE_TTL_SECONDS.airports);
    expectTtlAround(await cacheRedis.ttl(`fs:flight:${flight.flightId}`), CACHE_TTL_SECONDS.flightDetails);
    const searchKeys = await cacheRedis.keys('fs:search:*');
    expect(searchKeys).toHaveLength(1);
    expect(searchKeys[0]).toMatch(new RegExp(`^fs:search:v\\d+:BOM:DEL:${day}:departure$`));
    expectTtlAround(await cacheRedis.ttl(searchKeys[0]), CACHE_TTL_SECONDS.searchResults);
    expectTtlAround(await cacheRedis.ttl(`bs:seatmeta:${flight.flightId}`), CACHE_TTL_SECONDS.seatMeta);
    expectTtlAround(await cacheRedis.ttl(`bs:seats:${flight.flightId}`), CACHE_TTL_SECONDS.seatStatus);
    // the search version counter lives in redis-coord and never expires
    expect(await coordRedis.ttl('fs:searchver')).toBe(-1);
  });

  it('serves details from the cache until an admin write deletes them', async () => {
    const flight = await publishedFlight(admin, { basePrice: '5000' });
    const first = await client(app).get(`/api/flights/${flight.flightId}`);
    expect(first.body.flight.basePrice).toBe('5000.00');

    // A change made behind the API's back is invisible while the entry is cached: it IS a cache hit.
    await db.execute(sql`UPDATE flights SET base_price = 6000 WHERE id = ${flight.flightId}`);
    expect((await client(app).get(`/api/flights/${flight.flightId}`)).body.flight.basePrice).toBe('5000.00');

    // A cancel through the API deletes the key: fresh data (and the new status) immediately.
    await admin.post(`/api/admin/flights/${flight.flightId}/cancel`);
    const after = await client(app).get(`/api/flights/${flight.flightId}`);
    expect(after.body.flight.status).toBe('CANCELLED');
    expect(after.body.flight.basePrice).toBe('6000.00');
  });

  it('a DRAFT flight edited by an admin shows the change at once (PATCH deletes the cached details)', async () => {
    const { createFlight, createAircraft } = await import('./helpers/fixtures.js');
    const aircraft = await createAircraft(admin);
    const draft = await createFlight(admin, { aircraftId: aircraft.id, basePrice: '5000' });
    expect((await admin.get(`/api/flights/${draft.flightId}`)).body.flight.basePrice).toBe('5000.00');
    await admin.patch(`/api/admin/flights/${draft.flightId}`).send({ basePrice: '7000' });
    expect((await admin.get(`/api/flights/${draft.flightId}`)).body.flight.basePrice).toBe('7000.00');
    await admin.delete(`/api/admin/flights/${draft.flightId}`);
    expect((await admin.get(`/api/flights/${draft.flightId}`)).status).toBe(404);
  });

  it('publishing and cancelling are visible in search immediately (version bump), not after 60 s', async () => {
    const { createFlight, createAircraft } = await import('./helpers/fixtures.js');
    const day = indiaDate(2);
    const aircraft = await createAircraft(admin);
    const search = async () =>
      (await client(app).get(`/api/flights?from=BOM&to=DEL&date=${day}`)).body.flights.map((f: { flightId: number }) => f.flightId);

    const flight = await createFlight(admin, { aircraftId: aircraft.id, departureTime: indiaTime(day, 10) });
    expect(await search()).toEqual([]); // cached as empty
    const versionBefore = await coordRedis.get('fs:searchver');

    await admin.post(`/api/admin/flights/${flight.flightId}/publish`);
    expect(await coordRedis.get('fs:searchver')).not.toBe(versionBefore);
    expect(await search()).toEqual([flight.flightId]); // no 60 s wait

    const second = await createFlight(admin, { aircraftId: aircraft.id, departureTime: indiaTime(day, 14) });
    await admin.post(`/api/admin/flights/${second.flightId}/publish`);
    expect(await search()).toEqual([flight.flightId, second.flightId]);

    await admin.post(`/api/admin/flights/${flight.flightId}/cancel`);
    expect(await search()).toEqual([second.flightId]);
  });

  it('search results are cached per query (a behind-the-back change is invisible until the version bumps)', async () => {
    const day = indiaDate(2);
    const flight = await publishedFlight(admin, { departureTime: indiaTime(day, 10), basePrice: '5000' });
    const url = `/api/flights?from=BOM&to=DEL&date=${day}`;
    expect((await client(app).get(url)).body.flights[0].fromPrice).toBe('5000.00');
    await db.execute(sql`UPDATE flights SET base_price = 4000 WHERE id = ${flight.flightId}`);
    expect((await client(app).get(url)).body.flights[0].fromPrice).toBe('5000.00'); // cache hit
    await admin.post(`/api/admin/flights/${flight.flightId}/cancel`); // version bump
    expect((await client(app).get(url)).body.flights).toEqual([]);
  });

  it('search caches are per sort order', async () => {
    const day = indiaDate(2);
    await publishedFlight(admin, { departureTime: indiaTime(day, 9), basePrice: '7000' });
    await publishedFlight(admin, { departureTime: indiaTime(day, 15), basePrice: '3000' });
    const byDeparture = (await client(app).get(`/api/flights?from=BOM&to=DEL&date=${day}&sort=departure`)).body.flights;
    const byPrice = (await client(app).get(`/api/flights?from=BOM&to=DEL&date=${day}&sort=price`)).body.flights;
    expect(byDeparture.map((f: { fromPrice: string }) => f.fromPrice)).toEqual(['7000.00', '3000.00']);
    expect(byPrice.map((f: { fromPrice: string }) => f.fromPrice)).toEqual(['3000.00', '7000.00']);
    expect(await cacheRedis.keys('fs:search:*')).toHaveLength(2);
  });

  it('losing every cache key only costs performance, never correctness', async () => {
    const day = indiaDate(2);
    const flight = await publishedFlight(admin, { departureTime: indiaTime(day, 10) });
    const { http } = await newUser(app);
    const responses = async () => ({
      search: (await client(app).get(`/api/flights?from=BOM&to=DEL&date=${day}`)).body,
      details: (await client(app).get(`/api/flights/${flight.flightId}`)).body,
      seats: (await client(app).get(`/api/flights/${flight.flightId}/seats`)).body.seats.map((s: { seatId: number; status: string }) => [s.seatId, s.status])
    });
    await book(http, bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }]));
    const warm = await responses();
    await cacheRedis.flushdb(); // simulate LRU eviction of everything
    const cold = await responses();
    expect(cold).toEqual(warm);
    expect(await scalar(sql`SELECT COUNT(*) FROM flight_seats WHERE status = 'BOOKED'`)).toBe(1);
  });
});
