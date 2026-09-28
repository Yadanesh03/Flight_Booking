import type { Express } from 'express';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BOOKING_TX_MAX_RETRIES, BOOKING_REF_ALPHABET } from '@flight/shared';
import { db } from '../../apps/api/src/platform/db.js';
import { SimulatedCrash, getTestCounters, setTestHook } from '../../apps/api/src/platform/testSupport.js';
import { client, resetState, startTestApp, stopTestApp, type TestClient } from './helpers/testApp.js';
import {
  book,
  bookingBody,
  createGate,
  forceStatus,
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

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const [result] = (await db.execute(query)) as unknown as [T[]];
  return result;
}

const seatStatus = (seatId: number) => scalar<string>(sql`SELECT status FROM flight_seats WHERE id = ${seatId}`);
const bookingCount = () => scalar(sql`SELECT COUNT(*) FROM bookings`);

describe('POST /api/bookings: happy path', () => {
  it('confirms a multi-seat booking with server-side prices and the documented response', async () => {
    const flight = await publishedFlight(admin, { basePrice: '5000.00' });
    const { http, user } = await newUser(app);
    const a = flight.seat('2A'); // economy window 5350.00
    const b = flight.seat('2B'); // economy middle 5000.00

    const res = await book(http, {
      ...bookingBody(flight.flightId, [
        { seatId: a.seatId, fullName: 'Asha Rao', age: 34 },
        { seatId: b.seatId, fullName: 'Ravi Rao', age: 36 }
      ]),
      userId: 999999, // never trusted
      seats: [
        { seatId: a.seatId, price: '1.00', passenger: { fullName: 'Asha Rao', age: 34 } }, // client price ignored
        { seatId: b.seatId, passenger: { fullName: 'Ravi Rao', age: 36 } }
      ]
    });
    expect(res.status).toBe(201);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    expect(res.body).toEqual({
      bookingRef: expect.stringMatching(new RegExp(`^[${BOOKING_REF_ALPHABET}]{6}$`)),
      status: 'CONFIRMED',
      flight: {
        flightId: flight.flightId,
        flightNumber: flight.flightNumber,
        from: 'BOM',
        to: 'DEL',
        departureTime: expect.stringMatching(/Z$/),
        arrivalTime: expect.stringMatching(/Z$/)
      },
      seats: [
        { seatId: a.seatId, seatNumber: '2A', price: '5350.00', passenger: { fullName: 'Asha Rao', age: 34 } },
        { seatId: b.seatId, seatNumber: '2B', price: '5000.00', passenger: { fullName: 'Ravi Rao', age: 36 } }
      ],
      totalAmount: '10350.00',
      currency: 'INR',
      payment: { method: 'UPI', reference: expect.stringMatching(/^SIMPAY-[A-Z0-9]{8}$/) },
      confirmedAt: expect.stringMatching(/Z$/),
      createdAt: expect.stringMatching(/Z$/)
    });

    // Persisted state
    const booking = (await rows<Record<string, unknown>>(sql`SELECT * FROM bookings`))[0];
    expect(booking).toMatchObject({ user_id: user.id, status: 'CONFIRMED', total_amount: '10350.00', currency: 'INR', payment_method: 'UPI', failure_reason: null });
    expect(booking['booking_ref']).toBe(res.body.bookingRef);
    expect(String(booking['request_hash'])).toMatch(/^[0-9a-f]{64}$/);
    const snapshot = typeof booking['flight_snapshot'] === 'string' ? JSON.parse(booking['flight_snapshot']) : booking['flight_snapshot'];
    expect(snapshot).toEqual({
      flightNumber: flight.flightNumber,
      from: 'BOM',
      to: 'DEL',
      departureTime: res.body.flight.departureTime,
      arrivalTime: res.body.flight.arrivalTime
    });
    expect(await scalar(sql`SELECT COUNT(*) FROM flight_seats WHERE status = 'BOOKED' AND booking_id = ${booking['id']}`)).toBe(2);
    const passengers = await rows<{ seat_number: string; passenger_name: string; passenger_age: number; price: string }>(
      sql`SELECT seat_number, passenger_name, passenger_age, price FROM booking_seats ORDER BY seat_number`
    );
    expect(passengers).toEqual([
      { seat_number: '2A', passenger_name: 'Asha Rao', passenger_age: 34, price: '5350.00' },
      { seat_number: '2B', passenger_name: 'Ravi Rao', passenger_age: 36, price: '5000.00' }
    ]);

    // The seat map now shows both as BOOKED, others untouched.
    const map = await client(app).get(`/api/flights/${flight.flightId}/seats`);
    const booked = map.body.seats.filter((s: { status: string }) => s.status === 'BOOKED').map((s: { seatNumber: string }) => s.seatNumber);
    expect(booked).toEqual(['2A', '2B']);
  });

  it('sums money exactly for business + economy seats', async () => {
    const flight = await publishedFlight(admin, { basePrice: '3333.33' });
    const { http } = await newUser(app);
    const res = await book(http, bookingBody(flight.flightId, [{ seatId: flight.seat('1A').seatId }, { seatId: flight.seat('2C').seatId }]));
    expect(res.status).toBe(201);
    // 1A: 3333.33 x 2.5 = 8333.325 -> 8333.33, +350 = 8683.33 ; 2C: 3333.33 + 250 = 3583.33
    expect(res.body.seats.map((s: { price: string }) => s.price)).toEqual(['8683.33', '3583.33']);
    expect(res.body.totalAmount).toBe('12266.66');
  });

  it('books up to 6 seats in one booking', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    const seats = ['3A', '3B', '3C', '3D', '3E', '3F'].map((n) => ({ seatId: flight.seat(n).seatId }));
    const res = await book(http, bookingBody(flight.flightId, seats));
    expect(res.status).toBe(201);
    expect(res.body.seats).toHaveLength(6);
  });
});

describe('POST /api/bookings: request validation', () => {
  it('requires authentication and an allowed origin', async () => {
    const flight = await publishedFlight(admin);
    const body = bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }]);
    expect((await book(client(app), body)).status).toBe(401);
    const foreign = await client(app, 'https://evil.example').post('/api/bookings').set('Idempotency-Key', newKey()).send(body);
    expect(foreign.status).toBe(403);
    expect(await bookingCount()).toBe(0);
  });

  it('requires a well-formed Idempotency-Key header', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    const body = bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }]);

    const missing = await http.post('/api/bookings').send(body);
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    for (const bad of ['not-a-uuid', '12345678-1234-1234-1234-123456789012', 'x'.repeat(200)]) {
      const res = await http.post('/api/bookings').set('Idempotency-Key', bad).send(body);
      expect(res.status, bad).toBe(400);
      expect(res.body.error.code, bad).toBe('VALIDATION_ERROR');
    }
    expect(await bookingCount()).toBe(0);
  });

  it('rejects an invalid body with 400 before claiming anything', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    const seat = flight.seat('2A').seatId;
    const ok = bookingBody(flight.flightId, [{ seatId: seat }]);
    const many = ['2A', '2B', '2C', '2D', '2E', '2F', '3A'].map((n) => ({ seatId: flight.seat(n).seatId }));
    const bad: Array<[string, Record<string, unknown>]> = [
      ['no seats', { ...ok, seats: [] }],
      ['seven seats', bookingBody(flight.flightId, many)],
      ['duplicate seat ids', bookingBody(flight.flightId, [{ seatId: seat }, { seatId: seat }])],
      ['one-letter name', bookingBody(flight.flightId, [{ seatId: seat, fullName: 'A' }])],
      ['age 121', bookingBody(flight.flightId, [{ seatId: seat, age: 121 }])],
      ['negative age', bookingBody(flight.flightId, [{ seatId: seat, age: -1 }])],
      ['fractional age', bookingBody(flight.flightId, [{ seatId: seat, age: 30.5 }])],
      ['bad payment method', { ...ok, payment: { method: 'BITCOIN' } }],
      ['bad outcome', { ...ok, payment: { method: 'UPI', simulateOutcome: 'MAYBE' } }],
      ['string flight id', { ...ok, flightId: 'abc' }],
      ['missing payment', { flightId: flight.flightId, seats: ok['seats'] }]
    ];
    for (const [label, body] of bad) {
      const res = await book(http, body);
      expect(res.status, label).toBe(400);
      expect(res.body.error.code, label).toBe('VALIDATION_ERROR');
    }
    expect(await bookingCount()).toBe(0);
  });
});

describe('POST /api/bookings: flight and seat checks', () => {
  it('unknown flight -> 404 FLIGHT_NOT_FOUND and no booking row', async () => {
    const { http } = await newUser(app);
    const res = await book(http, bookingBody(424242, [{ seatId: 1 }]));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('FLIGHT_NOT_FOUND');
    expect(await bookingCount()).toBe(0);
  });

  it('seats that do not belong to the flight -> 400, recorded as FAILED and replayed identically', async () => {
    const flight = await publishedFlight(admin);
    const other = await publishedFlight(admin);
    const { http } = await newUser(app);
    const key = newKey();
    const body = bookingBody(flight.flightId, [{ seatId: other.seat('2A').seatId }]);
    const res = await book(http, body, key);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.seatIds).toEqual([other.seat('2A').seatId]);
    expect(await scalar<string>(sql`SELECT failure_reason FROM bookings`)).toBe('VALIDATION_ERROR');
    expect(await seatStatus(other.seat('2A').seatId)).toBe('AVAILABLE');

    const replay = await book(http, body, key);
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('VALIDATION_ERROR');
    expect(replay.headers['idempotent-replayed']).toBe('true');
  });

  it('cancelled flights and flights inside the 60-minute cutoff -> 409 FLIGHT_NOT_BOOKABLE', async () => {
    const cancelled = await publishedFlight(admin);
    await admin.post(`/api/admin/flights/${cancelled.flightId}/cancel`);
    const soon = new Date(Date.now() + 30 * 60_000);
    const cutoff = await publishedFlight(admin, { departureTime: soon, arrivalTime: new Date(soon.getTime() + 3_600_000) });
    const { http } = await newUser(app);

    for (const flight of [cancelled, cutoff]) {
      const res = await book(http, bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }]));
      expect(res.status, flight.flightNumber).toBe(409);
      expect(res.body.error.code).toBe('FLIGHT_NOT_BOOKABLE');
      expect(await seatStatus(flight.seat('2A').seatId)).toBe('AVAILABLE');
    }
    expect(await scalar(sql`SELECT COUNT(*) FROM bookings WHERE status = 'FAILED' AND failure_reason = 'FLIGHT_NOT_BOOKABLE'`)).toBe(2);
    expect(getTestCounters().paymentCalls).toBe(0); // never charged for an unbookable flight
  });

  it('a seat already booked by someone else -> 409 SEAT_UNAVAILABLE with the seat ids', async () => {
    const flight = await publishedFlight(admin);
    const first = await newUser(app);
    const second = await newUser(app);
    const seat = flight.seat('2A');
    expect((await book(first.http, bookingBody(flight.flightId, [{ seatId: seat.seatId }, { seatId: flight.seat('2B').seatId }]))).status).toBe(201);

    // Second user wants 2A (taken) and 2C (free): all-or-nothing.
    const res = await book(second.http, bookingBody(flight.flightId, [{ seatId: seat.seatId }, { seatId: flight.seat('2C').seatId }]));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SEAT_UNAVAILABLE');
    expect(res.body.error.details.seatIds).toEqual([seat.seatId]);
    expect(await seatStatus(flight.seat('2C').seatId)).toBe('AVAILABLE');
    expect(await scalar(sql`SELECT COUNT(*) FROM booking_seats`)).toBe(2);
    expect(await scalar<string>(sql`SELECT failure_reason FROM bookings WHERE user_id = ${second.user.id}`)).toBe('SEAT_UNAVAILABLE');
  });
});

describe('payment', () => {
  it('a declined payment -> 402, seats untouched, FAILED recorded, replay answers 402 without charging again', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    const seat = flight.seat('2A').seatId;
    const key = newKey();
    const body = bookingBody(flight.flightId, [{ seatId: seat }], { simulateOutcome: 'DECLINED' });

    const res = await book(http, body, key);
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('PAYMENT_DECLINED');
    expect(await seatStatus(seat)).toBe('AVAILABLE');
    expect(await scalar<string>(sql`SELECT failure_reason FROM bookings`)).toBe('PAYMENT_DECLINED');

    const replay = await book(http, body, key);
    expect(replay.status).toBe(402);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(getTestCounters().paymentCalls).toBe(1);

    // A fresh key (a new attempt) can succeed for the same seat.
    const retry = await book(http, bookingBody(flight.flightId, [{ seatId: seat }]), newKey());
    expect(retry.status).toBe(201);
    expect(getTestCounters().paymentCalls).toBe(2);
  });

  it('simulateOutcome defaults to SUCCESS and the payment takes 300-800 ms', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    const started = Date.now();
    const res = await book(http, bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }]));
    expect(res.status).toBe(201);
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
  });
});

describe('idempotency', () => {
  it('spec test 3: 10 parallel POSTs with one key -> one booking, one payment, same reference', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    const key = newKey();
    const body = bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }, { seatId: flight.seat('2B').seatId }]);

    const responses = await Promise.all(Array.from({ length: 10 }, () => book(http, body, key)));

    const created = responses.filter((r) => r.status === 201);
    expect(created).toHaveLength(1);
    const ref = created[0].body.bookingRef as string;
    for (const res of responses) {
      if (res.status === 409) {
        expect(res.body.error.code).toBe('BOOKING_IN_PROGRESS');
        expect(res.headers['retry-after']).toBe('2');
      } else {
        expect([200, 201]).toContain(res.status);
        expect(res.body.bookingRef).toBe(ref);
      }
    }
    expect(await bookingCount()).toBe(1);
    expect(await scalar(sql`SELECT COUNT(*) FROM booking_seats`)).toBe(2);
    expect(getTestCounters().paymentCalls).toBe(1);

    // After the winner finished, a retry returns the same booking (200 + replay header).
    const retry = await book(http, body, key);
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.bookingRef).toBe(ref);
    expect(retry.body).toEqual(created[0].body);
    expect(getTestCounters().paymentCalls).toBe(1);
  });

  it('a retry that arrives while the first attempt is in flight gets 409 BOOKING_IN_PROGRESS, then the same booking', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    const key = newKey();
    const body = bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }]);

    // Pause the first attempt right after its claim so the retry deterministically sees a PENDING row.
    const gate = createGate();
    setTestHook('afterClaim', gate.hook);
    const first = book(http, body, key).then((r) => r);
    await gate.reached;
    const during = await book(http, body, key);
    expect(during.status).toBe(409);
    expect(during.body.error.code).toBe('BOOKING_IN_PROGRESS');
    expect(during.headers['retry-after']).toBe('2');
    gate.release();
    const done = await first;
    expect(done.status).toBe(201);
    const after = await book(http, body, key);
    expect(after.status).toBe(200);
    expect(after.body.bookingRef).toBe(done.body.bookingRef);
  });

  it('spec test 4: same key with a different body -> 422 IDEMPOTENCY_KEY_REUSED (in flight and after completion)', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    const key = newKey();
    const original = bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }]);
    const different = bookingBody(flight.flightId, [{ seatId: flight.seat('2B').seatId }]);

    const gate = createGate();
    setTestHook('afterClaim', gate.hook);
    const first = book(http, original, key).then((r) => r);
    await gate.reached; // the original is claimed and paused
    const during = await book(http, different, key);
    expect(during.status).toBe(422);
    expect(during.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    gate.release();
    expect((await first).status).toBe(201);

    const after = await book(http, different, key);
    expect(after.status).toBe(422);
    expect(after.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // A different passenger name or payment method also counts as a different request.
    for (const variant of [
      bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId, fullName: 'Someone Else' }]),
      bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }], { method: 'CARD' })
    ]) {
      expect((await book(http, variant, key)).status).toBe(422);
    }
    expect(await bookingCount()).toBe(1);
    expect(getTestCounters().paymentCalls).toBe(1);
  });

  it('treats a re-ordered but identical request as the same request', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    const key = newKey();
    const a = { seatId: flight.seat('2A').seatId, fullName: 'Asha Rao', age: 34 };
    const b = { seatId: flight.seat('2B').seatId, fullName: 'Ravi Rao', age: 36 };
    const first = await book(http, bookingBody(flight.flightId, [a, b]), key);
    expect(first.status).toBe(201);
    const reordered = await book(http, bookingBody(flight.flightId, [b, a]), key);
    expect(reordered.status).toBe(200);
    expect(reordered.body.bookingRef).toBe(first.body.bookingRef);
  });

  it('idempotency keys are scoped per user', async () => {
    const flight = await publishedFlight(admin);
    const alice = await newUser(app);
    const bob = await newUser(app);
    const key = newKey();
    const a = await book(alice.http, bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }]), key);
    const b = await book(bob.http, bookingBody(flight.flightId, [{ seatId: flight.seat('2B').seatId }]), key);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.bookingRef).not.toBe(b.body.bookingRef);
  });

  it('a UUID key is matched case-insensitively', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    const key = newKey();
    const body = bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }]);
    const first = await book(http, body, key);
    const upper = await book(http, body, key.toUpperCase());
    expect(upper.status).toBe(200);
    expect(upper.body.bookingRef).toBe(first.body.bookingRef);
  });
});

describe('concurrency and locking', () => {
  it('spec test 2: 20 users confirm the same seat at once -> exactly one CONFIRMED', async () => {
    const flight = await publishedFlight(admin);
    const seat = flight.seat('2A');
    const users = await Promise.all(Array.from({ length: 20 }, () => newUser(app)));

    const responses = await Promise.all(users.map(({ http }) => book(http, bookingBody(flight.flightId, [{ seatId: seat.seatId }]))));

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    const losers = responses.filter((r) => r.status !== 201);
    expect(losers).toHaveLength(19);
    for (const res of losers) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SEAT_UNAVAILABLE');
    }
    expect(await scalar(sql`SELECT COUNT(*) FROM bookings WHERE status = 'CONFIRMED'`)).toBe(1);
    expect(await scalar(sql`SELECT COUNT(*) FROM bookings WHERE status = 'FAILED' AND failure_reason = 'SEAT_UNAVAILABLE'`)).toBe(19);
    expect(await scalar(sql`SELECT COUNT(*) FROM bookings WHERE status = 'PENDING'`)).toBe(0);
    expect(await scalar(sql`SELECT COUNT(*) FROM booking_seats WHERE flight_seat_id = ${seat.seatId}`)).toBe(1);
    expect(await seatStatus(seat.seatId)).toBe('BOOKED');
  });

  it('spec test 20: overlapping multi-seat bookings in opposite orders never deadlock; exactly one wins', async () => {
    const flight = await publishedFlight(admin, { rows: 12 });
    for (let round = 0; round < 6; round += 1) {
      const row = round + 3;
      const ids = ['A', 'B', 'C', 'D'].map((c) => flight.seat(`${row}${c}`).seatId);
      const [u1, u2] = [await newUser(app), await newUser(app)];
      const [r1, r2] = await Promise.all([
        book(u1.http, bookingBody(flight.flightId, ids.map((seatId) => ({ seatId })))),
        book(u2.http, bookingBody(flight.flightId, [...ids].reverse().map((seatId) => ({ seatId }))))
      ]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses, `round ${round}: ${JSON.stringify([r1.body, r2.body])}`).toEqual([201, 409]);
      const loser = r1.status === 409 ? r1 : r2;
      expect(loser.body.error.code).toBe('SEAT_UNAVAILABLE');
      expect(loser.body.error.details.seatIds.sort()).toEqual([...ids].sort());
    }
    expect(await scalar(sql`SELECT COUNT(*) FROM booking_seats`)).toBe(6 * 4);
  });

  it('partially overlapping concurrent bookings: seats are never double-booked and losers change nothing', async () => {
    const flight = await publishedFlight(admin, { rows: 10 });
    const seat = (n: string) => ({ seatId: flight.seat(n).seatId });
    const groups = [
      ['4A', '4B', '4C'],
      ['4C', '4D', '4E'],
      ['4E', '4F', '5A'],
      ['5A', '5B', '5C'],
      ['4B', '4D', '4F']
    ];
    const users = await Promise.all(groups.map(() => newUser(app)));
    const responses = await Promise.all(users.map(({ http }, i) => book(http, bookingBody(flight.flightId, groups[i].map(seat)))));
    for (const res of responses) expect([201, 409]).toContain(res.status);
    // No seat belongs to two bookings, and every booked seat belongs to exactly one CONFIRMED booking.
    expect(await scalar(sql`SELECT COUNT(*) FROM (SELECT flight_seat_id FROM booking_seats GROUP BY flight_seat_id HAVING COUNT(*) > 1) d`)).toBe(0);
    expect(await scalar(sql`SELECT COUNT(*) FROM flight_seats fs WHERE fs.status = 'BOOKED' AND NOT EXISTS (SELECT 1 FROM booking_seats bs WHERE bs.flight_seat_id = fs.id AND bs.booking_id = fs.booking_id)`)).toBe(0);
    expect(await scalar(sql`SELECT COUNT(*) FROM flight_seats WHERE status = 'BOOKED'`)).toBe(await scalar(sql`SELECT COUNT(*) FROM booking_seats`));
    for (const res of responses.filter((r) => r.status === 409)) expect(res.body.error.code).toBe('SEAT_UNAVAILABLE');
  });
});

describe('fault injection and recovery', () => {
  it('spec test 16: a fault after the seat UPDATE rolls back: seat AVAILABLE, booking FAILED INTERNAL_ERROR, HTTP 500', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    const seat = flight.seat('2A').seatId;
    setTestHook('afterSeatUpdate', () => {
      throw new Error('injected fault after seat update');
    });
    const key = newKey();
    const body = bookingBody(flight.flightId, [{ seatId: seat }]);

    const res = await book(http, body, key);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('injected'); // no internals leak
    expect(await seatStatus(seat)).toBe('AVAILABLE');
    expect(await scalar(sql`SELECT COUNT(*) FROM flight_seats WHERE booking_id IS NOT NULL`)).toBe(0);
    expect(await scalar(sql`SELECT COUNT(*) FROM booking_seats`)).toBe(0);
    expect(await scalar<string>(sql`SELECT status FROM bookings`)).toBe('FAILED');
    expect(await scalar<string>(sql`SELECT failure_reason FROM bookings`)).toBe('INTERNAL_ERROR');

    // Replay with the same key returns the same failure, without running anything again.
    const replay = await book(http, body, key);
    expect(replay.status).toBe(500);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(getTestCounters().paymentCalls).toBe(1);
  });

  it('spec test 17: a crash after the claim leaves PENDING; replay after the stale threshold -> BOOKING_ABANDONED, seat AVAILABLE', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    const seat = flight.seat('2A').seatId;
    setTestHook('afterClaim', () => {
      throw new SimulatedCrash();
    });
    const key = newKey();
    const body = bookingBody(flight.flightId, [{ seatId: seat }]);

    const crashed = await book(http, body, key);
    expect(crashed.status).toBe(500);
    // A crash cannot mark anything FAILED: the booking is left PENDING, and no seat was touched.
    expect(await scalar<string>(sql`SELECT status FROM bookings`)).toBe('PENDING');
    expect(await seatStatus(seat)).toBe('AVAILABLE');
    setTestHook('afterClaim', () => undefined);

    // Right away: the claim is fresh, so the client is told to wait.
    const early = await book(http, body, key);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('BOOKING_IN_PROGRESS');

    // After the (test-overridden, 2 s) stale threshold the booking is declared abandoned.
    await sleep(2300);
    const late = await book(http, body, key);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('BOOKING_ABANDONED');
    expect(late.headers['idempotent-replayed']).toBe('true');
    expect(await scalar<string>(sql`SELECT failure_reason FROM bookings`)).toBe('BOOKING_ABANDONED');
    expect(await seatStatus(seat)).toBe('AVAILABLE');
    expect(getTestCounters().paymentCalls).toBe(0);

    // The user simply retries with a new key and gets the seat.
    expect((await book(http, body, newKey())).status).toBe(201);
  });

  it('an attempt that was declared abandoned while still running cannot confirm afterwards', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    const seat = flight.seat('2A').seatId;
    const key = newKey();
    const body = bookingBody(flight.flightId, [{ seatId: seat }]);
    // The original request stalls, right after its claim, for much longer than the 2 s stale threshold;
    // the replay comes in once the claim is comfortably stale (margins are generous so a slow or busy
    // machine cannot make the claim look fresh), and well before the original wakes up.
    setTestHook('afterClaim', () => sleep(4000));

    const slow = book(http, body, key).then((r) => r);
    await sleep(2800);
    setTestHook('afterClaim', () => undefined);
    const replay = await book(http, body, key); // sees a stale PENDING and marks it abandoned
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('BOOKING_ABANDONED');

    const original = await slow; // continues, pays, reaches the confirm transaction...
    expect(original.status).toBe(409);
    expect(original.body.error.code).toBe('BOOKING_ABANDONED'); // ...and the guarded UPDATE affects 0 rows
    expect(await seatStatus(seat)).toBe('AVAILABLE'); // rolled back: seats never changed
    expect(await scalar(sql`SELECT COUNT(*) FROM booking_seats`)).toBe(0);
    expect(await scalar<string>(sql`SELECT status FROM bookings`)).toBe('FAILED');
  });

  it('retries a deadlock in the confirm transaction and then succeeds', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    let failures = 0;
    setTestHook('afterSeatLock', () => {
      if (failures < 2) {
        failures += 1;
        throw Object.assign(new Error('Deadlock found when trying to get lock'), { code: 'ER_LOCK_DEADLOCK' });
      }
    });
    const res = await book(http, bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }]));
    expect(res.status).toBe(201);
    expect(failures).toBe(2);
    expect(await seatStatus(flight.seat('2A').seatId)).toBe('BOOKED');
    expect(getTestCounters().paymentCalls).toBe(1); // the payment is NOT repeated on a Phase C retry
  });

  it(`gives up after ${BOOKING_TX_MAX_RETRIES} retries: 503 SERVICE_UNAVAILABLE, booking FAILED, seat AVAILABLE`, async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    let attempts = 0;
    setTestHook('afterSeatLock', () => {
      attempts += 1;
      throw Object.assign(new Error('Lock wait timeout exceeded'), { code: 'ER_LOCK_WAIT_TIMEOUT' });
    });
    const res = await book(http, bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }]));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(attempts).toBe(1 + BOOKING_TX_MAX_RETRIES);
    expect(await seatStatus(flight.seat('2A').seatId)).toBe('AVAILABLE');
    expect(await scalar<string>(sql`SELECT failure_reason FROM bookings`)).toBe('SERVICE_UNAVAILABLE');
  });

  it('does not leave the shortened lock-wait timeout on pooled connections', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    await book(http, bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }]));
    // Every pooled connection must be back at the server default (50 s), never the confirm tx's 5 s.
    const values = await Promise.all(Array.from({ length: 8 }, () => scalar(sql`SELECT @@session.innodb_lock_wait_timeout`)));
    for (const value of values) expect(Number(value)).toBe(50);
  });
});

describe('booking history and lookup', () => {
  async function confirmed(http: TestClient, flight: PublishedFlight, seatNumbers: string[]) {
    const res = await book(http, bookingBody(flight.flightId, seatNumbers.map((n) => ({ seatId: flight.seat(n).seatId }))));
    expect(res.status).toBe(201);
    return res.body as { bookingRef: string };
  }

  it('lists CONFIRMED bookings newest first by default, with status filters and cursor pagination', async () => {
    const flight = await publishedFlight(admin, { rows: 10 });
    const { http } = await newUser(app);
    const refs: string[] = [];
    for (const seat of ['2A', '2B', '2C']) refs.push((await confirmed(http, flight, [seat])).bookingRef);
    await book(http, bookingBody(flight.flightId, [{ seatId: flight.seat('3A').seatId }], { simulateOutcome: 'DECLINED' })); // FAILED

    const confirmedOnly = await http.get('/api/bookings');
    expect(confirmedOnly.status).toBe(200);
    expect(confirmedOnly.body.items.map((b: { bookingRef: string }) => b.bookingRef)).toEqual([...refs].reverse());
    expect(confirmedOnly.body.nextCursor).toBeNull();
    expect(confirmedOnly.body.items[0]).toMatchObject({ status: 'CONFIRMED', seats: [{ seatNumber: '2C' }], totalAmount: expect.any(String) });

    const failed = await http.get('/api/bookings?status=FAILED');
    expect(failed.body.items).toHaveLength(1);
    expect(failed.body.items[0]).toMatchObject({ status: 'FAILED', failureReason: 'PAYMENT_DECLINED', seats: [], totalAmount: '0.00', confirmedAt: null, flight: { flightId: flight.flightId } });

    const all = await http.get('/api/bookings?status=ALL');
    expect(all.body.items).toHaveLength(4);
    expect(all.body.items[0].status).toBe('FAILED'); // newest first

    const page1 = await http.get('/api/bookings?limit=2');
    expect(page1.body.items.map((b: { bookingRef: string }) => b.bookingRef)).toEqual([refs[2], refs[1]]);
    expect(page1.body.nextCursor).toBeTypeOf('number');
    const page2 = await http.get(`/api/bookings?limit=2&cursor=${page1.body.nextCursor}`);
    expect(page2.body.items.map((b: { bookingRef: string }) => b.bookingRef)).toEqual([refs[0]]);
    expect(page2.body.nextCursor).toBeNull();
  });

  it('never lists PENDING bookings and validates paging params', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    setTestHook('afterClaim', () => {
      throw new SimulatedCrash();
    });
    await book(http, bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }]));
    expect(await scalar<string>(sql`SELECT status FROM bookings`)).toBe('PENDING');
    for (const status of ['CONFIRMED', 'FAILED', 'ALL']) {
      expect((await http.get(`/api/bookings?status=${status}`)).body.items).toEqual([]);
    }
    for (const bad of ['limit=0', 'limit=51', 'limit=abc', 'cursor=-1', 'cursor=abc', 'status=PENDING']) {
      expect((await http.get(`/api/bookings?${bad}`)).status, bad).toBe(400);
    }
    expect((await http.get('/api/bookings?limit=50')).status).toBe(200);
  });

  it("shows only the caller's own bookings and requires a session", async () => {
    const flight = await publishedFlight(admin);
    const alice = await newUser(app);
    const bob = await newUser(app);
    await confirmed(alice.http, flight, ['2A']);
    await confirmed(bob.http, flight, ['2B']);
    expect((await alice.http.get('/api/bookings')).body.items).toHaveLength(1);
    expect((await client(app).get('/api/bookings')).status).toBe(401);
  });

  it('GET /api/bookings/:ref: owner and admin see it; everyone else gets 404 (not 403)', async () => {
    const flight = await publishedFlight(admin);
    const owner = await newUser(app);
    const stranger = await newUser(app);
    const { bookingRef } = await confirmed(owner.http, flight, ['2A']);

    const own = await owner.http.get(`/api/bookings/${bookingRef}`);
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ bookingRef, status: 'CONFIRMED', seats: [{ seatNumber: '2A' }] });
    expect((await owner.http.get(`/api/bookings/${bookingRef.toLowerCase()}`)).status).toBe(200);
    expect((await admin.get(`/api/bookings/${bookingRef}`)).status).toBe(200);

    const other = await stranger.http.get(`/api/bookings/${bookingRef}`);
    expect(other.status).toBe(404);
    expect(other.body.error.code).toBe('BOOKING_NOT_FOUND');
    const unknown = await stranger.http.get('/api/bookings/ZZZZZZ');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ ...other.body, requestId: unknown.body.requestId }); // indistinguishable
    expect((await client(app).get(`/api/bookings/${bookingRef}`)).status).toBe(401);
    expect((await owner.http.get('/api/bookings/abc')).status).toBe(400);
  });

  it('a PENDING booking is not retrievable by reference', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    setTestHook('afterClaim', () => {
      throw new SimulatedCrash();
    });
    await book(http, bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }]));
    const ref = await scalar<string>(sql`SELECT booking_ref FROM bookings`);
    expect((await http.get(`/api/bookings/${ref}`)).status).toBe(404);
  });
});

describe('invariants after mixed activity', () => {
  it('confirmed bookings, seats and passengers stay consistent', async () => {
    const flight = await publishedFlight(admin, { rows: 10 });
    const users = await Promise.all(Array.from({ length: 6 }, () => newUser(app)));
    await Promise.all(
      users.map(({ http }, i) =>
        book(http, bookingBody(flight.flightId, [{ seatId: flight.seat(`${3 + i}A`).seatId }, { seatId: flight.seat(`${3 + i}B`).seatId }], i % 3 === 2 ? { simulateOutcome: 'DECLINED' } : {}))
      )
    );
    // every CONFIRMED booking has exactly its seats marked BOOKED with its own id
    expect(
      await scalar(sql`SELECT COUNT(*) FROM bookings b WHERE b.status = 'CONFIRMED'
                        AND (SELECT COUNT(*) FROM booking_seats bs WHERE bs.booking_id = b.id) <>
                            (SELECT COUNT(*) FROM flight_seats fs WHERE fs.booking_id = b.id AND fs.status = 'BOOKED')`)
    ).toBe(0);
    // total_amount equals the sum of its seats' prices
    expect(
      await scalar(sql`SELECT COUNT(*) FROM bookings b WHERE b.status = 'CONFIRMED'
                        AND b.total_amount <> (SELECT SUM(price) FROM booking_seats bs WHERE bs.booking_id = b.id)`)
    ).toBe(0);
    // FAILED / PENDING bookings own no seats
    expect(await scalar(sql`SELECT COUNT(*) FROM bookings b JOIN booking_seats bs ON bs.booking_id = b.id WHERE b.status <> 'CONFIRMED'`)).toBe(0);
    expect(await scalar(sql`SELECT COUNT(*) FROM bookings WHERE status = 'PENDING'`)).toBe(0);
    expect(await scalar(sql`SELECT COUNT(*) FROM bookings WHERE status = 'CONFIRMED'`)).toBe(4);
  });

  it('cancelling a flight leaves existing bookings untouched', async () => {
    const flight = await publishedFlight(admin);
    const { http } = await newUser(app);
    const res = await book(http, bookingBody(flight.flightId, [{ seatId: flight.seat('2A').seatId }]));
    await forceStatus(flight.flightId, 'SCHEDULED');
    expect((await admin.post(`/api/admin/flights/${flight.flightId}/cancel`)).status).toBe(200);
    const still = await http.get(`/api/bookings/${res.body.bookingRef}`);
    expect(still.status).toBe(200);
    expect(still.body.status).toBe('CONFIRMED');
  });
});
