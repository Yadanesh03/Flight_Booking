import type { Express } from 'express';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../apps/api/src/platform/db.js';
import { clearTestHooks, setTestHook } from '../../apps/api/src/platform/testSupport.js';
import { client, resetState, startTestApp, stopTestApp, type TestClient } from './helpers/testApp.js';
import { createAircraft, createFlight, forceStatus, indiaDate, indiaTime, loginAdmin, loginAs, scalar, seedAirports } from './helpers/fixtures.js';

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

describe('POST /api/admin/flights/:id/publish', () => {
  it('creates priced inventory for every seat and marks the flight SCHEDULED', async () => {
    const aircraft = await createAircraft(admin, { totalRows: 6, businessRows: 1 }); // 36 seats
    const flight = await createFlight(admin, { aircraftId: aircraft.id, basePrice: '5000.00' });

    const res = await admin.post(`/api/admin/flights/${flight.flightId}/publish`);
    expect(res.status).toBe(200);
    expect(res.body.flight).toMatchObject({ flightId: flight.flightId, status: 'SCHEDULED' });

    expect(await scalar(sql`SELECT COUNT(*) FROM flight_seats WHERE flight_id = ${flight.flightId}`)).toBe(36);
    expect(await scalar(sql`SELECT COUNT(*) FROM flight_seats WHERE flight_id = ${flight.flightId} AND status = 'AVAILABLE' AND booking_id IS NULL`)).toBe(36);

    // price = base x (BUSINESS 2.5 | ECONOMY 1.0) + (WINDOW 350 | AISLE 250 | MIDDLE 0)
    const prices = Object.fromEntries(
      (await rows<{ seat_number: string; price: string }>(sql`SELECT seat_number, price FROM flight_seats WHERE flight_id = ${flight.flightId}`)).map((r) => [r.seat_number, r.price])
    );
    expect(prices).toMatchObject({
      '1A': '12850.00', // business window
      '1B': '12500.00', // business middle
      '1C': '12750.00', // business aisle
      '2A': '5350.00', // economy window
      '2B': '5000.00', // economy middle
      '2C': '5250.00', // economy aisle
      '6F': '5350.00'
    });

    // denormalised seat attributes come from the physical seat
    const seat = (await rows<Record<string, unknown>>(sql`SELECT * FROM flight_seats WHERE flight_id = ${flight.flightId} AND seat_number = '2A'`))[0];
    expect(seat).toMatchObject({ row_no: 2, column_code: 'A', cabin_class: 'ECONOMY', seat_type: 'WINDOW' });
    expect(await scalar(sql`SELECT COUNT(*) FROM flight_seats fs JOIN seats s ON s.id = fs.seat_id WHERE fs.flight_id = ${flight.flightId} AND s.seat_number = fs.seat_number`)).toBe(36);
  });

  it('makes the flight searchable with a seat map', async () => {
    const aircraft = await createAircraft(admin);
    const day = indiaDate(2);
    const flight = await createFlight(admin, { aircraftId: aircraft.id, departureTime: indiaTime(day, 9) });
    expect((await client(app).get(`/api/flights?from=BOM&to=DEL&date=${day}`)).body.flights).toHaveLength(0);

    await admin.post(`/api/admin/flights/${flight.flightId}/publish`);
    const search = await client(app).get(`/api/flights?from=BOM&to=DEL&date=${day}`);
    expect(search.body.flights.map((f: { flightId: number }) => f.flightId)).toEqual([flight.flightId]);
    expect((await client(app).get(`/api/flights/${flight.flightId}/seats`)).status).toBe(200);
  });

  it('refuses a second publish (409) without duplicating inventory', async () => {
    const aircraft = await createAircraft(admin);
    const flight = await createFlight(admin, { aircraftId: aircraft.id });
    expect((await admin.post(`/api/admin/flights/${flight.flightId}/publish`)).status).toBe(200);
    const again = await admin.post(`/api/admin/flights/${flight.flightId}/publish`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('FLIGHT_NOT_EDITABLE');
    expect(await scalar(sql`SELECT COUNT(*) FROM flight_seats WHERE flight_id = ${flight.flightId}`)).toBe(aircraft.seatCount);
  });

  it('refuses cancelled flights, flights that already departed, unknown flights, and non-admins', async () => {
    const aircraft = await createAircraft(admin);
    const cancelled = await createFlight(admin, { aircraftId: aircraft.id });
    await forceStatus(cancelled.flightId, 'CANCELLED');
    expect((await admin.post(`/api/admin/flights/${cancelled.flightId}/publish`)).status).toBe(409);

    const past = new Date(Date.now() - 3 * 3_600_000);
    const departed = await createFlight(admin, { aircraftId: aircraft.id, departureTime: past, arrivalTime: new Date(past.getTime() + 3_600_000) });
    const res = await admin.post(`/api/admin/flights/${departed.flightId}/publish`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FLIGHT_NOT_EDITABLE');
    expect(await scalar(sql`SELECT COUNT(*) FROM flight_seats`)).toBe(0);

    expect((await admin.post('/api/admin/flights/424242/publish')).status).toBe(404);
    const { http: user } = await loginAs(app, { email: 'user@example.com' });
    expect((await user.post(`/api/admin/flights/${cancelled.flightId}/publish`)).status).toBe(403);
  });

  it('two simultaneous publishes: exactly one wins, and inventory exists exactly once', async () => {
    const aircraft = await createAircraft(admin);
    const flight = await createFlight(admin, { aircraftId: aircraft.id });
    const results = await Promise.all([1, 2, 3].map(() => admin.post(`/api/admin/flights/${flight.flightId}/publish`)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await scalar(sql`SELECT COUNT(*) FROM flight_seats WHERE flight_id = ${flight.flightId}`)).toBe(aircraft.seatCount);
  });

  it('spec test 22: a fault after the inventory insert leaves the flight DRAFT with zero flight_seats', async () => {
    const aircraft = await createAircraft(admin);
    const flight = await createFlight(admin, { aircraftId: aircraft.id });
    let inventoryWasInsertedBeforeFault = 0;
    setTestHook('afterInventoryInsert', async () => {
      // Inside the transaction the rows are visible to us...
      inventoryWasInsertedBeforeFault = 1;
      throw new Error('injected fault after inventory insert');
    });

    const res = await admin.post(`/api/admin/flights/${flight.flightId}/publish`);
    expect(inventoryWasInsertedBeforeFault).toBe(1);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('injected fault'); // internals never leak

    // ...but after the rollback they are gone, and the flight is still an unpublished DRAFT.
    expect(await scalar(sql`SELECT COUNT(*) FROM flight_seats WHERE flight_id = ${flight.flightId}`)).toBe(0);
    expect(await scalar<string>(sql`SELECT status FROM flights WHERE id = ${flight.flightId}`)).toBe('DRAFT');
    const day = indiaDate(1);
    expect((await client(app).get(`/api/flights?from=BOM&to=DEL&date=${day}`)).body.flights).toHaveLength(0);
    expect((await client(app).get(`/api/flights/${flight.flightId}/seats`)).status).toBe(404);

    // A retry after the fault is cleared succeeds cleanly (no leftover rows to collide with).
    clearTestHooks();
    expect((await admin.post(`/api/admin/flights/${flight.flightId}/publish`)).status).toBe(200);
    expect(await scalar(sql`SELECT COUNT(*) FROM flight_seats WHERE flight_id = ${flight.flightId}`)).toBe(aircraft.seatCount);
  });
});

describe('GET /api/flights/:flightId/seats', () => {
  it('returns the layout and every seat with price and AVAILABLE status', async () => {
    const aircraft = await createAircraft(admin, { totalRows: 6, businessRows: 1 });
    const flight = await createFlight(admin, { aircraftId: aircraft.id, basePrice: '5000' });
    await admin.post(`/api/admin/flights/${flight.flightId}/publish`);

    const res = await client(app).get(`/api/flights/${flight.flightId}/seats`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      flightId: flight.flightId,
      holdsUnavailable: false,
      layout: { rows: 6, columns: ['A', 'B', 'C', null, 'D', 'E', 'F'] }
    });
    expect(new Date(res.body.serverTime).getTime()).toBeGreaterThan(Date.now() - 5000);
    expect(res.body.seats).toHaveLength(36);
    expect(res.body.seats[0]).toEqual({
      seatId: expect.any(Number),
      seatNumber: '1A',
      row: 1,
      column: 'A',
      cabinClass: 'BUSINESS',
      seatType: 'WINDOW',
      price: '12850.00',
      status: 'AVAILABLE'
    });
    const ids = res.body.seats.map((s: { seatId: number }) => s.seatId);
    expect(new Set(ids).size).toBe(36);
    // aircraft order: row, then column
    expect(res.body.seats.slice(0, 7).map((s: { seatNumber: string }) => s.seatNumber)).toEqual(['1A', '1B', '1C', '1D', '1E', '1F', '2A']);
  });

  it('shows BOOKED seats as BOOKED', async () => {
    const aircraft = await createAircraft(admin);
    const flight = await createFlight(admin, { aircraftId: aircraft.id });
    await admin.post(`/api/admin/flights/${flight.flightId}/publish`);
    await db.execute(sql`UPDATE flight_seats SET status = 'BOOKED' WHERE flight_id = ${flight.flightId} AND seat_number IN ('2A', '2B')`);
    const res = await client(app).get(`/api/flights/${flight.flightId}/seats`);
    const booked = res.body.seats.filter((s: { status: string }) => s.status === 'BOOKED').map((s: { seatNumber: string }) => s.seatNumber);
    expect(booked).toEqual(['2A', '2B']);
  });

  it('is 404 for DRAFT flights (no inventory) and unknown flights, and 400 for a bad id', async () => {
    const aircraft = await createAircraft(admin);
    const draft = await createFlight(admin, { aircraftId: aircraft.id });
    const res = await client(app).get(`/api/flights/${draft.flightId}/seats`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('FLIGHT_NOT_FOUND');
    expect((await client(app).get('/api/flights/424242/seats')).status).toBe(404);
    expect((await client(app).get('/api/flights/abc/seats')).status).toBe(400);
  });

  it('remains viewable after the flight is cancelled', async () => {
    const aircraft = await createAircraft(admin);
    const flight = await createFlight(admin, { aircraftId: aircraft.id });
    await admin.post(`/api/admin/flights/${flight.flightId}/publish`);
    await admin.post(`/api/admin/flights/${flight.flightId}/cancel`);
    expect((await client(app).get(`/api/flights/${flight.flightId}/seats`)).status).toBe(200);
  });
});

describe('database schema conforms to the spec DDL (Section 8)', () => {
  it('has every table, the cross-module foreign keys, and the hard uniqueness guards', async () => {
    const tables = (await rows<{ n: string }>(sql`SELECT table_name AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'`)).map((r) => r.n);
    expect(tables).toEqual(expect.arrayContaining(['users', 'airports', 'aircraft', 'seats', 'flights', 'flight_seats', 'bookings', 'booking_seats']));

    const fks = (await rows<{ n: string }>(sql`SELECT constraint_name AS n FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND constraint_type = 'FOREIGN KEY'`)).map((r) => r.n);
    expect(fks).toEqual(
      expect.arrayContaining(['fk_seats_aircraft', 'fk_flights_aircraft', 'fk_flights_src', 'fk_flights_dst', 'fk_fs_flight', 'fk_fs_seat', 'fk_bookings_user', 'fk_bookings_flight', 'fk_bs_booking', 'fk_bs_seat'])
    );

    const unique = (await rows<{ n: string }>(sql`SELECT DISTINCT index_name AS n FROM information_schema.statistics WHERE table_schema = DATABASE() AND non_unique = 0`)).map((r) => r.n);
    expect(unique).toEqual(
      expect.arrayContaining(['uq_users_email', 'uq_aircraft_code', 'uq_seat', 'uq_flight_departure', 'uq_flight_seat', 'uq_flight_seat_number', 'uq_booking_ref', 'uq_user_idempotency', 'uq_booked_seat'])
    );

    const checks = (await rows<{ n: string }>(sql`SELECT constraint_name AS n FROM information_schema.check_constraints WHERE constraint_schema = DATABASE()`)).map((r) => r.n);
    expect(checks).toEqual(expect.arrayContaining(['chk_route', 'chk_times', 'chk_price']));
  });

  it('every updated_at column is DATETIME(3) with ON UPDATE CURRENT_TIMESTAMP(3), and all times are DATETIME(3)', async () => {
    const updated = await rows<{ t: string; extra: string; type: string }>(
      sql`SELECT table_name AS t, extra AS extra, column_type AS type FROM information_schema.columns WHERE table_schema = DATABASE() AND column_name = 'updated_at'`
    );
    expect(updated.map((u) => u.t).sort()).toEqual(['bookings', 'flight_seats', 'flights', 'users']);
    for (const column of updated) {
      expect(column.type, column.t).toBe('datetime(3)');
      expect(column.extra.toLowerCase(), column.t).toContain('on update current_timestamp(3)');
    }
    const badTypes = await rows<{ c: string }>(
      sql`SELECT CONCAT(table_name, '.', column_name) AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND data_type IN ('datetime', 'timestamp') AND column_type <> 'datetime(3)'`
    );
    expect(badTypes).toEqual([]);
  });

  it('money columns are DECIMAL and the connection/session time zone is UTC', async () => {
    const money = await rows<{ c: string; type: string }>(
      sql`SELECT CONCAT(table_name, '.', column_name) AS c, column_type AS type FROM information_schema.columns WHERE table_schema = DATABASE() AND column_name IN ('base_price', 'price', 'total_amount')`
    );
    expect(money.length).toBeGreaterThanOrEqual(4);
    for (const column of money) expect(column.type, column.c).toMatch(/^decimal\(\d+,2\)$/);
    expect(await scalar<string>(sql`SELECT @@session.time_zone`)).toBe('+00:00');
  });

  it('the database itself refuses invalid flights (route/time/price CHECKs) and double-booked seats', async () => {
    const aircraft = await createAircraft(admin);
    const flight = await createFlight(admin, { aircraftId: aircraft.id });
    const bad = (fragment: ReturnType<typeof sql>) => db.execute(fragment);
    await expect(bad(sql`UPDATE flights SET destination_airport = source_airport WHERE id = ${flight.flightId}`)).rejects.toThrow();
    await expect(bad(sql`UPDATE flights SET arrival_time = departure_time WHERE id = ${flight.flightId}`)).rejects.toThrow();
    await expect(bad(sql`UPDATE flights SET base_price = 0 WHERE id = ${flight.flightId}`)).rejects.toThrow();

    // uq_booked_seat: a flight seat can be referenced by at most one booking_seats row.
    await admin.post(`/api/admin/flights/${flight.flightId}/publish`);
    const { user } = { user: (await loginAs(app, { email: 'u1@example.com' })).user };
    const seatId = await scalar<number>(sql`SELECT id FROM flight_seats WHERE flight_id = ${flight.flightId} LIMIT 1`);
    const insertBooking = async (ref: string, key: string): Promise<number> => {
      await db.execute(sql`INSERT INTO bookings (booking_ref, user_id, flight_id, status, idempotency_key, request_hash, payment_method) VALUES (${ref}, ${user.id}, ${flight.flightId}, 'CONFIRMED', ${key}, ${'0'.repeat(64)}, 'UPI')`);
      return scalar<number>(sql`SELECT id FROM bookings WHERE booking_ref = ${ref}`);
    };
    const b1 = await insertBooking('AAAAAA', '11111111-1111-4111-8111-111111111111');
    const b2 = await insertBooking('BBBBBB', '22222222-2222-4222-8222-222222222222');
    await db.execute(sql`INSERT INTO booking_seats (booking_id, flight_seat_id, seat_number, price, passenger_name, passenger_age) VALUES (${b1}, ${seatId}, '1A', 100, 'A B', 30)`);
    const duplicate = await db
      .execute(sql`INSERT INTO booking_seats (booking_id, flight_seat_id, seat_number, price, passenger_name, passenger_age) VALUES (${b2}, ${seatId}, '1A', 100, 'C D', 31)`)
      .then(() => null, (error: unknown) => error);
    expect(duplicate).not.toBeNull();
    // drizzle wraps the driver error: the MySQL message is on `cause`.
    expect(String((duplicate as { cause?: { message?: string } }).cause?.message)).toMatch(/Duplicate entry.*uq_booked_seat/);
  });
});
