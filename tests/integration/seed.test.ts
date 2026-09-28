import type { Express } from 'express';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalog } from '../../apps/api/src/seed/catalog.js';
import { db } from '../../apps/api/src/platform/db.js';
import { client, resetState, startTestApp, stopTestApp } from './helpers/testApp.js';
import { dateInZone } from '../../apps/api/src/platform/time.js';
import { indiaDate, indiaTime, scalar } from './helpers/fixtures.js';

let app: Express;

beforeAll(async () => {
  app = await startTestApp();
});
afterAll(stopTestApp);
beforeEach(resetState);

const options = { days: 2, adminEmail: 'admin@example.com', adminPassword: 'admin-password-1' };

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const [result] = (await db.execute(query)) as unknown as [T[]];
  return result;
}

describe('seedCatalog (Section 22)', () => {
  it('loads users, 12 airports, 8 aircraft and published flights that are searchable with seat maps', async () => {
    const result = await seedCatalog(options);
    expect(result.usersCreated).toBe(6); // admin + user1..user5
    expect(result.aircraftCreated).toBe(8);
    expect(result.flightsCreated).toBeGreaterThan(10);
    expect(result.flightsPublished).toBe(result.flightsCreated);

    expect(await scalar(sql`SELECT COUNT(*) FROM airports`)).toBe(12);
    expect(await scalar<string>(sql`SELECT role FROM users WHERE email = 'admin@example.com'`)).toBe('ADMIN');
    expect(await scalar(sql`SELECT COUNT(*) FROM users WHERE role = 'USER' AND email LIKE 'user_@example.com'`)).toBe(5);

    const sizes = await rows<{ model: string; seat_count: number }>(sql`SELECT model, seat_count FROM aircraft ORDER BY aircraft_code`);
    expect(sizes.map((s) => `${s.model}:${s.seat_count}`)).toEqual([
      'A320neo:180', 'A320neo:180', 'A320neo:180', 'A321neo:222', 'A321neo:222', 'B737-800:186', 'B737-800:186', 'ATR 72:72'
    ]);

    // Every flight went through the real publish logic: SCHEDULED, with full inventory.
    expect(await scalar(sql`SELECT COUNT(*) FROM flights WHERE status <> 'SCHEDULED'`)).toBe(0);
    expect(
      await scalar(sql`SELECT COUNT(*) FROM flights f JOIN aircraft a ON a.id = f.aircraft_id
                        WHERE (SELECT COUNT(*) FROM flight_seats fs WHERE fs.flight_id = f.id) <> a.seat_count`)
    ).toBe(0);

    // A real search + seat map over the seeded data.
    const sampleId = await scalar<number>(sql`SELECT id FROM flights WHERE departure_time > NOW() + INTERVAL 2 HOUR ORDER BY departure_time LIMIT 1`);
    const detail = (await client(app).get(`/api/flights/${sampleId}`)).body.flight as { from: string; to: string; departureTime: string };
    const date = dateInZone('Asia/Kolkata', new Date(detail.departureTime));
    const search = await client(app).get(`/api/flights?from=${detail.from}&to=${detail.to}&date=${date}`);
    expect(search.status).toBe(200);
    expect(search.body.flights.map((f: { flightId: number }) => f.flightId)).toContain(sampleId);
    const seatMap = await client(app).get(`/api/flights/${sampleId}/seats`);
    expect(seatMap.status).toBe(200);
    expect(seatMap.body.seats.length).toBeGreaterThanOrEqual(72);
  });

  it('follows the Section 22 rules: routes, airlines, durations, prices, ATR on short routes only', async () => {
    await seedCatalog({ ...options, days: 3 });
    const flights = await rows<{ flight_number: string; source_airport: string; destination_airport: string; model: string; base_price: string; minutes: number }>(
      sql`SELECT f.flight_number, f.source_airport, f.destination_airport, a.model, f.base_price,
                 TIMESTAMPDIFF(MINUTE, f.departure_time, f.arrival_time) AS minutes
            FROM flights f JOIN aircraft a ON a.id = f.aircraft_id`
    );
    expect(flights.length).toBeGreaterThan(20);

    const routes = new Set(flights.map((f) => `${f.source_airport}-${f.destination_airport}`));
    expect(routes.size).toBeLessThanOrEqual(20);
    expect(routes.size).toBeGreaterThanOrEqual(15);

    const prefixes = new Set(flights.map((f) => f.flight_number.split('-')[0]));
    for (const prefix of prefixes) expect(['AI', '6E', 'QP', 'SG', 'IX']).toContain(prefix);

    for (const f of flights) {
      expect(f.minutes, f.flight_number).toBeGreaterThanOrEqual(65); // 1h05m
      expect(f.minutes, f.flight_number).toBeLessThanOrEqual(180); // 3h
      expect(Number(f.base_price), f.flight_number).toBeGreaterThanOrEqual(3000);
      expect(Number(f.base_price), f.flight_number).toBeLessThanOrEqual(9000);
      if (f.model === 'ATR 72') {
        expect(['BOM-GOI', 'GOI-BOM', 'BOM-PNQ', 'PNQ-BOM']).toContain(`${f.source_airport}-${f.destination_airport}`);
      }
    }
    expect(flights.some((f) => f.model === 'ATR 72')).toBe(true);

    // 1-3 flights per route per day.
    const perRouteDay = await rows<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM flights GROUP BY source_airport, destination_airport, DATE(DATE_ADD(departure_time, INTERVAL 330 MINUTE))`
    );
    for (const { n } of perRouteDay) {
      expect(Number(n)).toBeGreaterThanOrEqual(1);
      expect(Number(n)).toBeLessThanOrEqual(3);
    }
  });

  it('is idempotent: a second run creates nothing and changes nothing', async () => {
    const first = await seedCatalog(options);
    const snapshot = async () => ({
      users: await scalar(sql`SELECT COUNT(*) FROM users`),
      aircraft: await scalar(sql`SELECT COUNT(*) FROM aircraft`),
      flights: await scalar(sql`SELECT COUNT(*) FROM flights`),
      seats: await scalar(sql`SELECT COUNT(*) FROM flight_seats`)
    });
    const before = await snapshot();
    const second = await seedCatalog(options);
    expect(second).toMatchObject({ usersCreated: 0, aircraftCreated: 0, flightsCreated: 0, flightsPublished: 0 });
    expect(second.flightsTotal).toBe(first.flightsTotal);
    expect(await snapshot()).toEqual(before);
  });

  it('is deterministic: the same date yields exactly the same flights', async () => {
    const now = indiaTime(indiaDate(0), 0); // start of today (IST): a fixed reference
    const dump = async () =>
      rows(sql`SELECT f.flight_number, f.departure_time, f.arrival_time, f.base_price, a.aircraft_code
                 FROM flights f JOIN aircraft a ON a.id = f.aircraft_id ORDER BY f.flight_number, f.departure_time`);
    await seedCatalog({ ...options, days: 2, now });
    const first = await dump();
    expect(first.length).toBeGreaterThan(20);
    await resetState();
    await seedCatalog({ ...options, days: 2, now });
    expect(await dump()).toEqual(first);
  }, 180_000);

  it('publishes flights a previous run left as DRAFT', async () => {
    await seedCatalog(options);
    const id = await scalar<number>(sql`SELECT id FROM flights ORDER BY id LIMIT 1`);
    await db.execute(sql`DELETE FROM flight_seats WHERE flight_id = ${id}`);
    await db.execute(sql`UPDATE flights SET status = 'DRAFT' WHERE id = ${id}`);
    const rerun = await seedCatalog(options);
    expect(rerun).toMatchObject({ flightsCreated: 0, flightsPublished: 1 });
    expect(await scalar<string>(sql`SELECT status FROM flights WHERE id = ${id}`)).toBe('SCHEDULED');
  });

  it('skips demo users and the admin when asked / when not configured', async () => {
    const result = await seedCatalog({ days: 1, demoUsers: false });
    expect(result.usersCreated).toBe(0);
    expect(await scalar(sql`SELECT COUNT(*) FROM users`)).toBe(0);
  });
});
