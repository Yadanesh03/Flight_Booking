import type { Express } from 'express';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HOLD_ACQUISITIONS_PER_HOUR, MAX_FLIGHTS_WITH_ACTIVE_HOLDS, MAX_SEATS_PER_FLIGHT_HOLD } from '@flight/shared';
import { config } from '../../apps/api/src/platform/config.js';
import { db } from '../../apps/api/src/platform/db.js';
import { cacheRedis, coordRedis } from '../../apps/api/src/platform/redis.js';
import { getTestCounters, setTestHook } from '../../apps/api/src/platform/testSupport.js';
import { client, resetState, startTestApp, stopTestApp, withRedisDown, type TestClient } from './helpers/testApp.js';
import {
  book,
  bookingBody,
  holdSeats,
  indiaDate,
  indiaTime,
  loginAdmin,
  newKey,
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

/** Wait until every hold made `since` ms ago has expired (plus a safety margin). */
const waitForExpiry = (sinceMs = 0) => sleep(config.holdTtlSeconds * 1000 + 600 - sinceMs);

const ids = (flight: PublishedFlight, ...seatNumbers: string[]) => seatNumbers.map((n) => flight.seat(n).seatId);
const seatMap = (http: TestClient, flight: PublishedFlight) => http.get(`/api/flights/${flight.flightId}/seats`);
const statusOf = (body: { seats: Array<{ seatNumber: string; status: string }> }, seatNumber: string) =>
  body.seats.find((s) => s.seatNumber === seatNumber)?.status;
const myHolds = async (http: TestClient) => (await http.get('/api/holds')).body.holds as Array<{ flightId: number; seatId: number; seatNumber: string; expiresAt: string }>;

describe('PUT /api/flights/:flightId/holds', () => {
  it('holds seats for the configured TTL and returns them with expiry and serverTime', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    const before = Date.now();
    const res = await holdSeats(http, flight.flightId, ids(flight, '2A', '2B'));
    expect(res.status).toBe(200);
    expect(res.body.holds).toEqual([
      { flightId: flight.flightId, seatId: flight.seat('2A').seatId, seatNumber: '2A', expiresAt: expect.any(String) },
      { flightId: flight.flightId, seatId: flight.seat('2B').seatId, seatNumber: '2B', expiresAt: expect.any(String) }
    ]);
    for (const hold of res.body.holds) {
      const expiresAt = new Date(hold.expiresAt).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + config.holdTtlSeconds * 1000 - 500);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + config.holdTtlSeconds * 1000 + 500);
    }
    expect(Math.abs(new Date(res.body.serverTime).getTime() - Date.now())).toBeLessThan(2000);
  });

  it('requires a session, a valid body, and known seats/flights', async () => {
    const flight = await publishedFlight(admin);
    const other = await publishedFlight(admin);
    const { http } = await newUser(app);
    const seat = flight.seat('2A').seatId;

    expect((await client(app).put(`/api/flights/${flight.flightId}/holds`).send({ seatIds: [seat] })).status).toBe(401);
    for (const [label, body] of [
      ['empty', { seatIds: [] }],
      ['missing', {}],
      ['duplicates', { seatIds: [seat, seat] }],
      ['strings', { seatIds: ['a'] }],
      ['negative', { seatIds: [-1] }],
      ['fractions', { seatIds: [1.5] }]
    ] as const) {
      const res = await http.put(`/api/flights/${flight.flightId}/holds`).send(body);
      expect(res.status, label).toBe(400);
      expect(res.body.error.code, label).toBe('VALIDATION_ERROR');
    }
    // A seat of another flight, and a non-existent seat: 400 naming the offending ids.
    const foreign = await holdSeats(http, flight.flightId, [seat, other.seat('2A').seatId, 999_999_999]);
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.details.seatIds).toEqual([other.seat('2A').seatId, 999_999_999]);
    expect(await coordRedis.hlen(`bs:holds:${flight.flightId}`)).toBe(0);

    expect((await holdSeats(http, 424242, [seat])).status).toBe(404);
    expect((await http.put('/api/flights/abc/holds').send({ seatIds: [seat] })).status).toBe(400);
  });

  it('refuses a DRAFT (unpublished) flight with 409 FLIGHT_NOT_BOOKABLE', async () => {
    const { createAircraft, createFlight } = await import('./helpers/fixtures.js');
    const aircraft = await createAircraft(admin);
    const draft = await createFlight(admin, { aircraftId: aircraft.id });
    const { http } = await newUser(app);
    const res = await holdSeats(http, draft.flightId, [1]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FLIGHT_NOT_BOOKABLE');
  });

  it('refuses seats that are already BOOKED with 409 SEAT_UNAVAILABLE', async () => {
    const flight = await publishedFlight(admin);
    const first = await newUser(app);
    const second = await newUser(app);
    expect((await book(first.http, bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }]))).status).toBe(201);
    const res = await holdSeats(second.http, flight.flightId, ids(flight, '2A', '2B'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SEAT_UNAVAILABLE');
    expect(res.body.error.details.seatIds).toEqual(ids(flight, '2A'));
    expect(await myHolds(second.http)).toEqual([]);
  });

  it('refuses flights inside the booking cutoff', async () => {
    const soon = new Date(Date.now() + 30 * 60_000);
    const flight = await publishedFlight(admin, { departureTime: soon, arrivalTime: new Date(soon.getTime() + 3_600_000) });
    const { http } = await newUser(app);
    const res = await holdSeats(http, flight.flightId, ids(flight, '2A'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FLIGHT_NOT_BOOKABLE');
  });
});

describe('spec test 1: 50 users hold the same seat at once', () => {
  it('exactly one gets 200; the other 49 get 409 SEAT_TEMPORARILY_UNAVAILABLE', async () => {
    const flight = await publishedFlight(admin);
    const seat = flight.seat('2A').seatId;
    const users = [];
    for (let i = 0; i < 50; i += 1) users.push(await newUser(app));

    const responses = await Promise.all(users.map(({ http }) => holdSeats(http, flight.flightId, [seat])));

    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    const losers = responses.filter((r) => r.status === 409);
    expect(losers).toHaveLength(49);
    for (const res of losers) {
      expect(res.body.error.code).toBe('SEAT_TEMPORARILY_UNAVAILABLE');
      expect(res.body.error.details.seatIds).toEqual([seat]);
    }
    const winnerIndex = responses.findIndex((r) => r.status === 200);
    expect(await coordRedis.hkeys(`bs:holds:${flight.flightId}`)).toEqual([String(seat)]);
    const holder = Number((await coordRedis.hget(`bs:holds:${flight.flightId}`, String(seat)))!.split('|')[0]);
    expect(holder).toBe(users[winnerIndex].user.id);
  });
});

describe('spec test 5: hold expiry frees the seat', () => {
  it('after the TTL another user can hold the seat', async () => {
    const flight = await publishedFlight(admin);
    const seat = ids(flight, '2A');
    const first = await newUser(app);
    const second = await newUser(app);
    expect((await holdSeats(first.http, flight.flightId, seat)).status).toBe(200);
    const blocked = await holdSeats(second.http, flight.flightId, seat);
    expect(blocked.status).toBe(409);

    await waitForExpiry();
    expect(statusOf((await seatMap(second.http, flight)).body, '2A')).toBe('AVAILABLE');
    expect((await holdSeats(second.http, flight.flightId, seat)).status).toBe(200);
    expect(await myHolds(first.http)).toEqual([]);
  });
});

describe('spec test 6: paying after the hold expired', () => {
  it('409 HOLD_EXPIRED, booking FAILED, nothing charged, and the replay says the same', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    const seat = flight.seat('2A').seatId;
    expect((await holdSeats(http, flight.flightId, [seat])).status).toBe(200);
    await waitForExpiry();

    const key = newKey();
    const body = bookingBody(flight.flightId, [{ seatId: seat }]);
    const res = await book(http, body, key, { holds: 'none' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HOLD_EXPIRED');
    expect(await scalar<string>(sql`SELECT status FROM bookings`)).toBe('FAILED');
    expect(await scalar<string>(sql`SELECT failure_reason FROM bookings`)).toBe('HOLD_EXPIRED');
    expect(getTestCounters().paymentCalls).toBe(0);
    expect(await scalar<string>(sql`SELECT status FROM flight_seats WHERE id = ${seat}`)).toBe('AVAILABLE');

    const replay = await book(http, body, key, { holds: 'none' });
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('HOLD_EXPIRED');
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(await scalar(sql`SELECT COUNT(*) FROM bookings`)).toBe(1);
  });

  it('a hold that expired and was re-taken by someone else cannot be used to book', async () => {
    const flight = await publishedFlight(admin);
    const seat = flight.seat('2A').seatId;
    const first = await newUser(app);
    const second = await newUser(app);
    await holdSeats(first.http, flight.flightId, [seat]);
    await waitForExpiry();
    expect((await holdSeats(second.http, flight.flightId, [seat])).status).toBe(200);

    const res = await book(first.http, bookingBody(flight.flightId, [{ seatId: seat }]), newKey(), { holds: 'none' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HOLD_EXPIRED');
    // ...while the new holder can.
    expect((await book(second.http, bookingBody(flight.flightId, [{ seatId: seat }]), newKey(), { holds: 'none' })).status).toBe(201);
  });

  it('booking seats held by another user (or not held at all) is refused before any payment', async () => {
    const flight = await publishedFlight(admin);
    const holder = await newUser(app);
    const other = await newUser(app);
    await holdSeats(holder.http, flight.flightId, ids(flight, '2A'));
    const stolen = await book(other.http, bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }]), newKey(), { holds: 'none' });
    expect(stolen.status).toBe(409);
    expect(stolen.body.error.code).toBe('HOLD_EXPIRED');
    const never = await book(other.http, bookingBody(flight.flightId, [{ seatId: flight.seat('3A').seatId }]), newKey(), { holds: 'none' });
    expect(never.status).toBe(409);
    expect(getTestCounters().paymentCalls).toBe(0);
    // A partially-held request is refused too: the user must hold EVERY seat.
    await holdSeats(other.http, flight.flightId, ids(flight, '4A'));
    const partial = await book(other.http, bookingBody(flight.flightId, [{ seatId: flight.seat('4A').seatId }, { seatId: flight.seat('4B').seatId }]), newKey(), { holds: 'none' });
    expect(partial.status).toBe(409);
    expect(partial.body.error.code).toBe('HOLD_EXPIRED');
  });
});

describe('spec test 7: all-or-nothing', () => {
  it('B holds 12B; A asks for 12A, 12B, 12C -> 409 naming 12B, and A holds nothing', async () => {
    const flight = await publishedFlight(admin, { rows: 14 });
    const a = await newUser(app);
    const b = await newUser(app);
    await holdSeats(b.http, flight.flightId, ids(flight, '12B'));

    const res = await holdSeats(a.http, flight.flightId, ids(flight, '12A', '12B', '12C'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SEAT_TEMPORARILY_UNAVAILABLE');
    expect(res.body.error.details.seatIds).toEqual(ids(flight, '12B'));

    expect(await myHolds(a.http)).toEqual([]);
    const map = (await seatMap(a.http, flight)).body;
    expect(statusOf(map, '12A')).toBe('AVAILABLE');
    expect(statusOf(map, '12C')).toBe('AVAILABLE');
    expect(statusOf(map, '12B')).toBe('HELD'); // shown as "temporarily unavailable"
    expect(await myHolds(b.http)).toHaveLength(1);
  });
});

describe('spec test 8: limits', () => {
  it(`more than ${MAX_SEATS_PER_FLIGHT_HOLD} seats -> 422 HOLD_LIMIT_EXCEEDED, nothing changes`, async () => {
    const flight = await publishedFlight(admin, { rows: 10 });
    const { http } = await newUser(app);
    const res = await holdSeats(http, flight.flightId, ids(flight, '3A', '3B', '3C', '3D', '3E', '3F', '4A'));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('HOLD_LIMIT_EXCEEDED');
    expect(res.body.error.details.limit).toBe(MAX_SEATS_PER_FLIGHT_HOLD);
    expect(await myHolds(http)).toEqual([]);
    // exactly the limit is fine
    expect((await holdSeats(http, flight.flightId, ids(flight, '3A', '3B', '3C', '3D', '3E', '3F'))).status).toBe(200);
  });

  it(`a third flight -> 422 HOLD_LIMIT_EXCEEDED (limit ${MAX_FLIGHTS_WITH_ACTIVE_HOLDS})`, async () => {
    const f1 = await publishedFlight(admin);
    const f2 = await publishedFlight(admin);
    const f3 = await publishedFlight(admin);
    const { http } = await newUser(app);
    expect((await holdSeats(http, f1.flightId, ids(f1, '2A'))).status).toBe(200);
    expect((await holdSeats(http, f2.flightId, ids(f2, '2A'))).status).toBe(200);
    const res = await holdSeats(http, f3.flightId, ids(f3, '2A'));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('HOLD_LIMIT_EXCEEDED');
    expect(res.body.error.details.limit).toBe(MAX_FLIGHTS_WITH_ACTIVE_HOLDS);
    expect((await myHolds(http)).map((h) => h.flightId).sort()).toEqual([f1.flightId, f2.flightId].sort());
    // Releasing one flight frees a slot.
    await http.delete(`/api/flights/${f1.flightId}/holds`);
    expect((await holdSeats(http, f3.flightId, ids(f3, '2A'))).status).toBe(200);
  });
});

describe('spec test 9: holds are never extended', () => {
  it('re-PUTting the same seats later leaves expiresAt unchanged', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    const first = await holdSeats(http, flight.flightId, ids(flight, '2A', '2B'));
    await sleep(1200); // (the spec says 2 s; the test TTL is 3 s, so stay safely inside it)
    const again = await holdSeats(http, flight.flightId, ids(flight, '2A', '2B'));
    expect(again.status).toBe(200);
    expect(again.body.holds.map((h: { expiresAt: string }) => h.expiresAt)).toEqual(first.body.holds.map((h: { expiresAt: string }) => h.expiresAt));
    const [ttl] = (await coordRedis.call('HTTL', `bs:holds:${flight.flightId}`, 'FIELDS', 1, String(flight.seat('2A').seatId))) as number[];
    expect(ttl).toBeLessThanOrEqual(config.holdTtlSeconds - 1);
  });
});

describe('spec test 10: replace semantics', () => {
  it('{A,B} then {B,C}: holds become {B,C}, A is free, B keeps its original expiry', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    const other = await newUser(app);
    const first = await holdSeats(http, flight.flightId, ids(flight, '2A', '2B'));
    const expiry = (res: typeof first, seat: string) => res.body.holds.find((h: { seatNumber: string }) => h.seatNumber === seat).expiresAt as string;
    await sleep(300);

    const second = await holdSeats(http, flight.flightId, ids(flight, '2B', '2C'));
    expect(second.status).toBe(200);
    expect(second.body.holds.map((h: { seatNumber: string }) => h.seatNumber)).toEqual(['2B', '2C']);
    expect(expiry(second, '2B')).toBe(expiry(first, '2B')); // kept, not extended
    expect(new Date(expiry(second, '2C')).getTime()).toBeGreaterThan(new Date(expiry(first, '2B')).getTime());

    expect((await myHolds(http)).map((h) => h.seatNumber)).toEqual(['2B', '2C']);
    const map = (await seatMap(other.http, flight)).body;
    expect(statusOf(map, '2A')).toBe('AVAILABLE');
    expect(statusOf(map, '2B')).toBe('HELD');
    expect((await holdSeats(other.http, flight.flightId, ids(flight, '2A'))).status).toBe(200); // A is really free
  });
});

describe('seat map states (Section 15.1)', () => {
  it('AVAILABLE / HELD_BY_YOU / HELD / BOOKED, per viewer, with BOOKED taking precedence', async () => {
    const flight = await publishedFlight(admin);
    const a = await newUser(app);
    const b = await newUser(app);
    await holdSeats(a.http, flight.flightId, ids(flight, '2A', '2B'));
    await holdSeats(b.http, flight.flightId, ids(flight, '3A'));
    expect((await book(b.http, bookingBody(flight.flightId, [{ seatId: flight.seat('3A').seatId }]))).status).toBe(201);
    await holdSeats(b.http, flight.flightId, ids(flight, '4A'));

    const forA = (await seatMap(a.http, flight)).body;
    expect(statusOf(forA, '2A')).toBe('HELD_BY_YOU');
    expect(statusOf(forA, '2B')).toBe('HELD_BY_YOU');
    expect(statusOf(forA, '3A')).toBe('BOOKED');
    expect(statusOf(forA, '4A')).toBe('HELD');
    expect(statusOf(forA, '5A')).toBe('AVAILABLE');
    const mine = forA.seats.find((s: { seatNumber: string }) => s.seatNumber === '2A');
    expect(mine.holdExpiresAt).toMatch(/Z$/);
    expect(forA.seats.find((s: { seatNumber: string }) => s.seatNumber === '4A').holdExpiresAt).toBeUndefined(); // others' expiry is private
    expect(forA.holdsUnavailable).toBe(false);

    const anonymous = (await seatMap(client(app), flight)).body;
    expect(statusOf(anonymous, '2A')).toBe('HELD');
    expect(statusOf(anonymous, '3A')).toBe('BOOKED');

    // A seat that is both held and booked shows BOOKED.
    await db.execute(sql`UPDATE flight_seats SET status = 'BOOKED' WHERE id = ${flight.seat('2A').seatId}`);
    await cacheRedis.flushdb();
    expect(statusOf((await seatMap(a.http, flight)).body, '2A')).toBe('BOOKED');
  });

  it('a held seat returns to AVAILABLE once its hold expires', async () => {
    const flight = await publishedFlight(admin);
    const a = await newUser(app);
    const b = await newUser(app);
    await holdSeats(a.http, flight.flightId, ids(flight, '2A'));
    expect(statusOf((await seatMap(b.http, flight)).body, '2A')).toBe('HELD');
    await waitForExpiry();
    expect(statusOf((await seatMap(b.http, flight)).body, '2A')).toBe('AVAILABLE');
  });
});

describe('DELETE /api/flights/:flightId/holds and GET /api/holds', () => {
  it('releases only the caller\'s seats on that flight (204, idempotent)', async () => {
    const f1 = await publishedFlight(admin);
    const f2 = await publishedFlight(admin);
    const a = await newUser(app);
    const b = await newUser(app);
    await holdSeats(a.http, f1.flightId, ids(f1, '2A', '2B'));
    await holdSeats(a.http, f2.flightId, ids(f2, '2A'));
    await holdSeats(b.http, f1.flightId, ids(f1, '3A'));

    expect((await a.http.delete(`/api/flights/${f1.flightId}/holds`)).status).toBe(204);
    expect((await a.http.delete(`/api/flights/${f1.flightId}/holds`)).status).toBe(204); // again: still 204
    expect((await myHolds(a.http)).map((h) => h.flightId)).toEqual([f2.flightId]);
    expect(await myHolds(b.http)).toHaveLength(1);
    expect(statusOf((await seatMap(b.http, f1)).body, '2A')).toBe('AVAILABLE');
    expect((await client(app).delete(`/api/flights/${f1.flightId}/holds`)).status).toBe(401);
  });

  it('lists the caller\'s holds across flights with seat numbers, ordered by flight then seat', async () => {
    const f1 = await publishedFlight(admin);
    const f2 = await publishedFlight(admin);
    const { http } = await newUser(app);
    await holdSeats(http, f2.flightId, ids(f2, '3B'));
    await holdSeats(http, f1.flightId, ids(f1, '2C', '2A'));
    const res = await http.get('/api/holds');
    expect(res.status).toBe(200);
    expect(res.body.holds.map((h: { flightId: number; seatNumber: string }) => [h.flightId, h.seatNumber])).toEqual([
      [f1.flightId, '2A'],
      [f1.flightId, '2C'],
      [f2.flightId, '3B']
    ]);
    expect(res.body.serverTime).toMatch(/Z$/);
    expect((await client(app).get('/api/holds')).status).toBe(401);
  });

  it('drops expired holds from the list', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    await holdSeats(http, flight.flightId, ids(flight, '2A'));
    expect(await myHolds(http)).toHaveLength(1);
    await waitForExpiry();
    expect(await myHolds(http)).toEqual([]);
  });
});

describe('holds and bookings', () => {
  it('a booking releases exactly its own seats\' holds and leaves the rest', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    const three = ids(flight, '2A', '2B', '2C');
    expect((await holdSeats(http, flight.flightId, three)).status).toBe(200);
    const res = await book(http, bookingBody(flight.flightId, [{ seatId: three[0] }, { seatId: three[1] }]), newKey(), { holds: 'none' });
    expect(res.status).toBe(201);
    expect((await myHolds(http)).map((h) => h.seatNumber)).toEqual(['2C']);
    expect(await coordRedis.hkeys(`bs:holds:${flight.flightId}`)).toEqual([String(three[2])]);
    expect(statusOf((await seatMap(http, flight)).body, '2A')).toBe('BOOKED');
    expect(statusOf((await seatMap(http, flight)).body, '2C')).toBe('HELD_BY_YOU');
  });

  it('spec test 21: a declined payment keeps the hold, and a retry with a new key succeeds', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    const seat = flight.seat('2A').seatId;
    expect((await holdSeats(http, flight.flightId, [seat])).status).toBe(200);

    const declined = await book(http, bookingBody(flight.flightId, [{ seatId: seat }], { simulateOutcome: 'DECLINED' }), newKey(), { holds: 'none' });
    expect(declined.status).toBe(402);
    expect(declined.body.error.code).toBe('PAYMENT_DECLINED');
    expect((await myHolds(http)).map((h) => h.seatId)).toEqual([seat]); // hold kept

    const retry = await book(http, bookingBody(flight.flightId, [{ seatId: seat }]), newKey(), { holds: 'none' });
    expect(retry.status).toBe(201);
    expect(await scalar(sql`SELECT COUNT(*) FROM bookings WHERE status = 'CONFIRMED'`)).toBe(1);
    expect(await scalar(sql`SELECT COUNT(*) FROM bookings WHERE status = 'FAILED' AND failure_reason = 'PAYMENT_DECLINED'`)).toBe(1);
    expect(getTestCounters().paymentCalls).toBe(2);
    expect(await myHolds(http)).toEqual([]);
  });

  it('spec test 23: after a flight is cancelled, holding and booking are refused immediately', async () => {
    const flight = await publishedFlight(admin);
    const holder = await newUser(app);
    const newcomer = await newUser(app);
    await holdSeats(holder.http, flight.flightId, ids(flight, '2A'));

    expect((await admin.post(`/api/admin/flights/${flight.flightId}/cancel`)).status).toBe(200);

    const hold = await holdSeats(newcomer.http, flight.flightId, ids(flight, '3A'));
    expect(hold.status).toBe(409);
    expect(hold.body.error.code).toBe('FLIGHT_NOT_BOOKABLE');
    const rehold = await holdSeats(holder.http, flight.flightId, ids(flight, '2A'));
    expect(rehold.status).toBe(409);
    expect(rehold.body.error.code).toBe('FLIGHT_NOT_BOOKABLE');
    // The holder still has a live hold, but paying is refused: getBookability reads MySQL every time.
    const res = await book(holder.http, bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }]), newKey(), { holds: 'none' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FLIGHT_NOT_BOOKABLE');
    expect(getTestCounters().paymentCalls).toBe(0);
    expect(await scalar<string>(sql`SELECT status FROM flight_seats WHERE id = ${flight.seat('2A').seatId}`)).toBe('AVAILABLE');
  });
});

describe('hourly acquisition quota', () => {
  it(`caps NEWLY acquired seats at ${HOLD_ACQUISITIONS_PER_HOUR} per hour; re-holding what you already hold is free`, async () => {
    const flight = await publishedFlight(admin, { rows: 12 });
    const { http, user } = await newUser(app);
    const six = ids(flight, '3A', '3B', '3C', '3D', '3E', '3F');

    // Release-and-re-hold cycling: each cycle acquires 6 NEW holds, which is what the quota stops.
    for (let cycle = 0; cycle < 6; cycle += 1) {
      expect((await holdSeats(http, flight.flightId, six)).status, `cycle ${cycle}`).toBe(200);
      expect((await http.delete(`/api/flights/${flight.flightId}/holds`)).status).toBe(204);
    }
    const hourIndex = Math.floor(Date.now() / 3_600_000);
    expect(Number(await coordRedis.get(`bs:holdquota:${user.id}:${hourIndex}`))).toBe(36);
    expect(await coordRedis.ttl(`bs:holdquota:${user.id}:${hourIndex}`)).toBeGreaterThan(7000);

    const over = await holdSeats(http, flight.flightId, ids(flight, '3A', '3B', '3C', '3D', '3E')); // 36 + 5 = 41
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('HOLD_QUOTA_EXCEEDED');
    expect(Number(over.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(over.headers['retry-after'])).toBeLessThanOrEqual(3600);
    expect(await myHolds(http)).toEqual([]);

    const exactly = await holdSeats(http, flight.flightId, ids(flight, '3A', '3B', '3C', '3D')); // 36 + 4 = 40: allowed
    expect(exactly.status).toBe(200);
    // Seats already held don't count: re-PUT the same four any number of times.
    for (let i = 0; i < 3; i += 1) expect((await holdSeats(http, flight.flightId, ids(flight, '3A', '3B', '3C', '3D'))).status).toBe(200);
    // ...but one more NEW seat is over the quota.
    expect((await holdSeats(http, flight.flightId, ids(flight, '3A', '3B', '3C', '3D', '3E'))).status).toBe(429);
    expect(Number(await coordRedis.get(`bs:holdquota:${user.id}:${hourIndex}`))).toBe(40);
  });

  it('is tracked per user', async () => {
    const flight = await publishedFlight(admin);
    const a = await newUser(app);
    const b = await newUser(app);
    await holdSeats(a.http, flight.flightId, ids(flight, '2A', '2B'));
    await holdSeats(b.http, flight.flightId, ids(flight, '3A'));
    const hour = Math.floor(Date.now() / 3_600_000);
    expect(Number(await coordRedis.get(`bs:holdquota:${a.user.id}:${hour}`))).toBe(2);
    expect(Number(await coordRedis.get(`bs:holdquota:${b.user.id}:${hour}`))).toBe(1);
  });
});

describe('spec test 18: redis-coord down', () => {
  it('search and the seat map (without hold info) work; holds and bookings answer 503 SERVICE_DEGRADED; nothing is created', async () => {
    const day = indiaDate(2);
    const flight = await publishedFlight(admin, { departureTime: indiaTime(day, 10) });
    const { http } = await newUser(app);
    await holdSeats(http, flight.flightId, ids(flight, '2A')); // a hold that exists before the outage

    await withRedisDown('coord', async () => {
      const search = await client(app).get(`/api/flights?from=BOM&to=DEL&date=${day}`);
      expect(search.status).toBe(200);
      expect(search.body.flights).toHaveLength(1);

      const map = await seatMap(client(app), flight);
      expect(map.status).toBe(200);
      expect(map.body.holdsUnavailable).toBe(true);
      expect(map.body.seats).toHaveLength(36);
      expect(map.body.seats.every((s: { status: string }) => s.status === 'AVAILABLE' || s.status === 'BOOKED')).toBe(true); // no HELD info

      const hold = await holdSeats(http, flight.flightId, ids(flight, '3A'));
      expect(hold.status).toBe(503);
      expect(hold.body.error.code).toBe('SERVICE_DEGRADED');
      const booking = await book(http, bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }]), newKey(), { holds: 'none' });
      expect(booking.status).toBe(503);
      expect(booking.body.error.code).toBe('SERVICE_DEGRADED');
      expect((await http.get('/api/holds')).status).toBe(503);
    });

    // Bookings are refused, never performed without coordination.
    expect(await scalar(sql`SELECT COUNT(*) FROM bookings`)).toBe(0);
    expect(await scalar(sql`SELECT COUNT(*) FROM flight_seats WHERE status = 'BOOKED'`)).toBe(0);
    // After recovery everything works again, including the session and the pre-outage hold.
    expect((await myHolds(http)).map((h) => h.seatNumber)).toEqual(['2A']);
    expect((await book(http, bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }]), newKey(), { holds: 'none' })).status).toBe(201);
  });

  it('losing redis-coord in the middle of a booking fails it cleanly: FAILED SERVICE_DEGRADED, 503, nothing charged or booked', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    const seat = flight.seat('2A').seatId;
    await holdSeats(http, flight.flightId, [seat]);
    const key = newKey();
    const body = bookingBody(flight.flightId, [{ seatId: seat }]);

    setTestHook('afterClaim', () => {
      coordRedis.disconnect(); // redis-coord dies right after the claim, before the hold check
    });
    const res = await book(http, body, key, { holds: 'none' });
    // `disconnect()` transitions to "end" asynchronously; `connect()` throws if called before that lands.
    for (let i = 0; i < 100 && coordRedis.status !== 'end'; i += 1) await sleep(30);
    await coordRedis.connect();
    for (let i = 0; i < 100 && coordRedis.status !== 'ready'; i += 1) await sleep(30);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_DEGRADED');
    expect(await scalar<string>(sql`SELECT status FROM bookings`)).toBe('FAILED');
    expect(await scalar<string>(sql`SELECT failure_reason FROM bookings`)).toBe('SERVICE_DEGRADED');
    expect(await scalar<string>(sql`SELECT status FROM flight_seats WHERE id = ${seat}`)).toBe('AVAILABLE');
    expect(getTestCounters().paymentCalls).toBe(0);

    const replay = await book(http, body, key, { holds: 'none' });
    expect(replay.status).toBe(503);
    expect(replay.headers['idempotent-replayed']).toBe('true');
  });
});

describe('admin inventory (Section 15.9)', () => {
  it('reports seat counts, booked, available and currently held', async () => {
    const flight = await publishedFlight(admin); // 36 seats
    const a = await newUser(app);
    const b = await newUser(app);
    await book(a.http, bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }, { seatId: flight.seat('2B').seatId }]));
    await holdSeats(b.http, flight.flightId, ids(flight, '3A', '3B', '3C'));

    const res = await admin.get(`/api/admin/inventory/flights/${flight.flightId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ seatCount: 36, booked: 2, available: 34, heldNow: 3 });

    await waitForExpiry();
    expect((await admin.get(`/api/admin/inventory/flights/${flight.flightId}`)).body.heldNow).toBe(0);
    expect((await admin.get('/api/admin/inventory/flights/424242')).status).toBe(404);
    expect((await a.http.get(`/api/admin/inventory/flights/${flight.flightId}`)).status).toBe(403);
    expect((await client(app).get(`/api/admin/inventory/flights/${flight.flightId}`)).status).toBe(401);
  });
});
