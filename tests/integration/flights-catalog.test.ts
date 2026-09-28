import type { Express } from 'express';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_LIST_PAGE_SIZE, BOOKING_CUTOFF_MINUTES, SEARCH_MAX_DAYS_AHEAD } from '@flight/shared';
import { flightsAdminService, flightsService } from '../../apps/api/src/modules/flights/index.js';
import { client, resetState, startTestApp, stopTestApp, type TestClient } from './helpers/testApp.js';
import {
  AIRPORTS,
  createAircraft,
  createFlight,
  forceStatus,
  type FlightOptions,
  indiaDate,
  indiaTime,
  loginAdmin,
  loginAs,
  scalar,
  seedAirports
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

describe('admin authorization', () => {
  it('rejects anonymous callers with 401 and non-admins with 403 on every admin route', async () => {
    const { http: user } = await loginAs(app, { email: 'user@example.com' });
    const routes: Array<['get' | 'post' | 'patch' | 'delete', string]> = [
      ['post', '/api/admin/aircraft'],
      ['get', '/api/admin/aircraft'],
      ['post', '/api/admin/flights'],
      ['get', '/api/admin/flights'],
      ['patch', '/api/admin/flights/1'],
      ['delete', '/api/admin/flights/1'],
      ['post', '/api/admin/flights/1/cancel']
    ];
    for (const [method, path] of routes) {
      const anonymous = await client(app)[method](path).send({});
      expect(anonymous.status, `anonymous ${method} ${path}`).toBe(401);
      const asUser = await user[method](path).send({});
      expect(asUser.status, `user ${method} ${path}`).toBe(403);
      expect(asUser.body.error.code).toBe('FORBIDDEN');
    }
  });
});

describe('POST /api/admin/aircraft', () => {
  it('creates the aircraft with generated seats and a computed seat count', async () => {
    const res = await admin.post('/api/admin/aircraft').send({
      aircraftCode: 'vt-exa',
      model: 'A320neo',
      layoutColumns: 'ABC-DEF',
      totalRows: 30,
      businessRows: 2,
      seatCount: 999 // ignored: seat_count is always computed
    });
    expect(res.status).toBe(201);
    expect(res.body.aircraft).toMatchObject({ aircraftCode: 'VT-EXA', model: 'A320neo', totalRows: 30, businessRows: 2, seatCount: 180 });

    const id = res.body.aircraft.id as number;
    expect(await scalar(sql`SELECT COUNT(*) FROM seats WHERE aircraft_id = ${id}`)).toBe(180);
    expect(await scalar(sql`SELECT COUNT(*) FROM seats WHERE aircraft_id = ${id} AND cabin_class = 'BUSINESS'`)).toBe(12);
    expect(await scalar(sql`SELECT seat_type FROM seats WHERE aircraft_id = ${id} AND seat_number = '1A'`)).toBe('WINDOW');
    expect(await scalar(sql`SELECT seat_type FROM seats WHERE aircraft_id = ${id} AND seat_number = '1C'`)).toBe('AISLE');
    expect(await scalar(sql`SELECT seat_type FROM seats WHERE aircraft_id = ${id} AND seat_number = '1B'`)).toBe('MIDDLE');
    expect(await scalar(sql`SELECT cabin_class FROM seats WHERE aircraft_id = ${id} AND seat_number = '3A'`)).toBe('ECONOMY');
  });

  it('supports the ATR 72 two-by-two layout', async () => {
    const aircraft = await createAircraft(admin, { model: 'ATR 72', layoutColumns: 'AC-DF', totalRows: 18, businessRows: 0 });
    expect(aircraft.seatCount).toBe(72);
  });

  it('rejects invalid layouts and sizes with 400', async () => {
    const base = { aircraftCode: 'VT-BAD', model: 'X', layoutColumns: 'ABC-DEF', totalRows: 10, businessRows: 1 };
    const bad: Array<Record<string, unknown>> = [
      { ...base, layoutColumns: 'ABC--DEF' },
      { ...base, layoutColumns: '-ABC' },
      { ...base, layoutColumns: 'ABC-CDE' }, // duplicate column letters
      { ...base, layoutColumns: '123' },
      { ...base, totalRows: 0 },
      { ...base, totalRows: 5, businessRows: 6 },
      { ...base, aircraftCode: 'x' },
      { ...base, model: '' }
    ];
    for (const body of bad) {
      const res = await admin.post('/api/admin/aircraft').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await scalar(sql`SELECT COUNT(*) FROM aircraft`)).toBe(0);
  });

  it('rejects a duplicate aircraft code and leaves no orphan seats', async () => {
    await createAircraft(admin, { aircraftCode: 'VT-DUP' });
    const seatsBefore = await scalar(sql`SELECT COUNT(*) FROM seats`);
    const res = await admin.post('/api/admin/aircraft').send({
      aircraftCode: 'VT-DUP',
      model: 'A320neo',
      layoutColumns: 'ABC-DEF',
      totalRows: 6,
      businessRows: 1
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues[0].path).toBe('aircraftCode');
    expect(await scalar(sql`SELECT COUNT(*) FROM seats`)).toBe(seatsBefore);
  });

  it('lists aircraft', async () => {
    await createAircraft(admin, { aircraftCode: 'VT-AAA' });
    await createAircraft(admin, { aircraftCode: 'VT-BBB' });
    const res = await admin.get('/api/admin/aircraft');
    expect(res.status).toBe(200);
    expect(res.body.aircraft.map((a: { aircraftCode: string }) => a.aircraftCode)).toEqual(['VT-AAA', 'VT-BBB']);
  });
});

describe('POST /api/admin/flights', () => {
  it('creates a DRAFT flight', async () => {
    const aircraft = await createAircraft(admin);
    const res = await admin.post('/api/admin/flights').send({
      flightNumber: 'ai-101',
      aircraftId: aircraft.id,
      from: 'bom',
      to: 'DEL',
      departureTime: '2026-10-05T03:30:00.000Z',
      arrivalTime: '2026-10-05T05:40:00.000Z',
      basePrice: 5499
    });
    expect(res.status).toBe(201);
    expect(res.body.flight).toMatchObject({
      flightNumber: 'AI-101',
      from: 'BOM',
      to: 'DEL',
      status: 'DRAFT',
      basePrice: '5499.00',
      durationMinutes: 130,
      aircraftModel: 'A320neo',
      departureTime: '2026-10-05T03:30:00.000Z',
      arrivalTime: '2026-10-05T05:40:00.000Z'
    });
  });

  it('validates the flight', async () => {
    const aircraft = await createAircraft(admin);
    const ok = {
      flightNumber: 'AI-101',
      aircraftId: aircraft.id,
      from: 'BOM',
      to: 'DEL',
      departureTime: '2026-10-05T03:30:00.000Z',
      arrivalTime: '2026-10-05T05:40:00.000Z',
      basePrice: '5499.00'
    };
    const bad: Array<[string, Record<string, unknown>]> = [
      ['same origin and destination', { ...ok, to: 'BOM' }],
      ['arrival before departure', { ...ok, arrivalTime: '2026-10-05T03:00:00.000Z' }],
      ['arrival equal to departure', { ...ok, arrivalTime: ok.departureTime }],
      ['unknown aircraft', { ...ok, aircraftId: 99999 }],
      ['unknown origin airport', { ...ok, from: 'XXX' }],
      ['unknown destination airport', { ...ok, to: 'ZZZ' }],
      ['zero price', { ...ok, basePrice: 0 }],
      ['negative price', { ...ok, basePrice: '-5' }],
      ['3-decimal price', { ...ok, basePrice: '10.123' }],
      ['bad flight number', { ...ok, flightNumber: 'AI101' }],
      ['bad date-time', { ...ok, departureTime: 'tomorrow' }],
      ['missing field', { ...ok, basePrice: undefined }]
    ];
    for (const [label, body] of bad) {
      const res = await admin.post('/api/admin/flights').send(body);
      expect(res.status, label).toBe(400);
      expect(res.body.error.code, label).toBe('VALIDATION_ERROR');
    }
    expect(await scalar(sql`SELECT COUNT(*) FROM flights`)).toBe(0);
  });

  it('rejects a duplicate (flight number, departure time)', async () => {
    const aircraft = await createAircraft(admin);
    await createFlight(admin, { aircraftId: aircraft.id, flightNumber: 'AI-777' });
    const res = await admin.post('/api/admin/flights').send({
      flightNumber: 'AI-777',
      aircraftId: aircraft.id,
      from: 'BOM',
      to: 'DEL',
      departureTime: indiaTime(indiaDate(1), 10).toISOString(),
      arrivalTime: indiaTime(indiaDate(1), 12).toISOString(),
      basePrice: '4000'
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues[0].path).toBe('flightNumber');
  });
});

describe('GET /api/admin/flights', () => {
  it('lists newest first, filters by status, and paginates with a cursor', async () => {
    const aircraft = await createAircraft(admin);
    const total = ADMIN_LIST_PAGE_SIZE + 3;
    const created: number[] = [];
    for (let i = 0; i < total; i += 1) {
      const departure = indiaTime(indiaDate(2 + (i % 5)), 6 + Math.floor(i / 5));
      const flight = await flightsAdminService.createFlight({
        flightNumber: `AI-${200 + i}`,
        aircraftId: aircraft.id,
        from: 'BOM',
        to: 'DEL',
        departureTime: departure,
        arrivalTime: new Date(departure.getTime() + 7_200_000),
        basePrice: '4000.00'
      });
      created.push(flight.flightId);
    }
    await forceStatus(created[0], 'SCHEDULED');

    const page1 = await admin.get('/api/admin/flights');
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(ADMIN_LIST_PAGE_SIZE);
    expect(page1.body.items[0].flightId).toBe(created.at(-1));
    expect(page1.body.nextCursor).toBe(page1.body.items.at(-1).flightId);

    const page2 = await admin.get(`/api/admin/flights?cursor=${page1.body.nextCursor}`);
    expect(page2.body.items).toHaveLength(3);
    expect(page2.body.nextCursor).toBeNull();
    const ids = [...page1.body.items, ...page2.body.items].map((f: { flightId: number }) => f.flightId);
    expect(new Set(ids).size).toBe(total);

    const scheduled = await admin.get('/api/admin/flights?status=SCHEDULED');
    expect(scheduled.body.items.map((f: { flightId: number }) => f.flightId)).toEqual([created[0]]);
    expect((await admin.get('/api/admin/flights?status=BOGUS')).status).toBe(400);
  });
});

describe('PATCH /api/admin/flights/:id', () => {
  it('edits a DRAFT flight, validating the merged result', async () => {
    const aircraft = await createAircraft(admin);
    const flight = await createFlight(admin, { aircraftId: aircraft.id });

    const price = await admin.patch(`/api/admin/flights/${flight.flightId}`).send({ basePrice: '6100.50', to: 'HYD' });
    expect(price.status).toBe(200);
    expect(price.body.flight).toMatchObject({ basePrice: '6100.50', to: 'HYD', from: 'BOM' });

    // Only one side of a pair is sent: it is checked against the stored other side.
    const badTime = await admin.patch(`/api/admin/flights/${flight.flightId}`).send({
      arrivalTime: new Date(new Date(flight.departureTime).getTime() - 60_000).toISOString()
    });
    expect(badTime.status).toBe(400);
    const sameRoute = await admin.patch(`/api/admin/flights/${flight.flightId}`).send({ from: 'HYD' });
    expect(sameRoute.status).toBe(400);
    const unknownAircraft = await admin.patch(`/api/admin/flights/${flight.flightId}`).send({ aircraftId: 424242 });
    expect(unknownAircraft.status).toBe(400);
    expect((await admin.patch(`/api/admin/flights/${flight.flightId}`).send({})).status).toBe(400);
  });

  it('409 FLIGHT_NOT_EDITABLE once published; 404 for unknown; 400 for a bad id', async () => {
    const aircraft = await createAircraft(admin);
    const flight = await createFlight(admin, { aircraftId: aircraft.id });
    await forceStatus(flight.flightId, 'SCHEDULED');
    const res = await admin.patch(`/api/admin/flights/${flight.flightId}`).send({ basePrice: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FLIGHT_NOT_EDITABLE');

    const missing = await admin.patch('/api/admin/flights/424242').send({ basePrice: 1 });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('FLIGHT_NOT_FOUND');
    expect((await admin.patch('/api/admin/flights/abc').send({ basePrice: 1 })).status).toBe(400);
  });

  it('rejects changing to a duplicate flight number + departure', async () => {
    const aircraft = await createAircraft(admin);
    await createFlight(admin, { aircraftId: aircraft.id, flightNumber: 'AI-501' });
    const other = await createFlight(admin, { aircraftId: aircraft.id, flightNumber: 'AI-502' });
    const res = await admin.patch(`/api/admin/flights/${other.flightId}`).send({ flightNumber: 'AI-501' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/admin/flights/:id', () => {
  it('deletes DRAFT flights only', async () => {
    const aircraft = await createAircraft(admin);
    const draft = await createFlight(admin, { aircraftId: aircraft.id });
    const scheduled = await createFlight(admin, { aircraftId: aircraft.id });
    await forceStatus(scheduled.flightId, 'SCHEDULED');

    expect((await admin.delete(`/api/admin/flights/${draft.flightId}`)).status).toBe(204);
    expect(await scalar(sql`SELECT COUNT(*) FROM flights WHERE id = ${draft.flightId}`)).toBe(0);

    const res = await admin.delete(`/api/admin/flights/${scheduled.flightId}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FLIGHT_NOT_EDITABLE');
    expect((await admin.delete('/api/admin/flights/424242')).status).toBe(404);
  });
});

describe('POST /api/admin/flights/:id/cancel', () => {
  it('cancels a SCHEDULED flight; refuses DRAFT and already-cancelled flights', async () => {
    const aircraft = await createAircraft(admin);
    const flight = await createFlight(admin, { aircraftId: aircraft.id });
    const draft = await admin.post(`/api/admin/flights/${flight.flightId}/cancel`);
    expect(draft.status).toBe(409);

    await forceStatus(flight.flightId, 'SCHEDULED');
    const res = await admin.post(`/api/admin/flights/${flight.flightId}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.flight.status).toBe('CANCELLED');

    expect((await admin.post(`/api/admin/flights/${flight.flightId}/cancel`)).status).toBe(409);
    expect((await admin.post('/api/admin/flights/424242/cancel')).status).toBe(404);
  });
});

describe('GET /api/airports', () => {
  it('lists airports without authentication', async () => {
    const res = await client(app).get('/api/airports');
    expect(res.status).toBe(200);
    expect(res.body.airports.map((a: { code: string }) => a.code)).toEqual(AIRPORTS.map((a) => a.code).sort());
    expect(res.body.airports[0]).toEqual(expect.objectContaining({ code: expect.any(String), timezone: 'Asia/Kolkata' }));
  });
});

describe('GET /api/flights (search)', () => {
  const day = (): string => indiaDate(3);

  async function scheduledFlight(aircraftId: number, options: Omit<FlightOptions, 'aircraftId'>): Promise<number> {
    const flight = await createFlight(admin, { aircraftId, ...options });
    await forceStatus(flight.flightId, 'SCHEDULED');
    return flight.flightId;
  }

  it('returns only SCHEDULED flights on the route and day, in the documented shape', async () => {
    const aircraft = await createAircraft(admin);
    const scheduled = await scheduledFlight(aircraft.id, { departureTime: indiaTime(day(), 10) });
    await createFlight(admin, { aircraftId: aircraft.id, departureTime: indiaTime(day(), 11) }); // DRAFT
    const cancelled = await scheduledFlight(aircraft.id, { departureTime: indiaTime(day(), 12) });
    await forceStatus(cancelled, 'CANCELLED');
    await scheduledFlight(aircraft.id, { departureTime: indiaTime(day(), 13), to: 'HYD' }); // other route
    await scheduledFlight(aircraft.id, { departureTime: indiaTime(indiaDate(4), 10) }); // other day

    const res = await client(app).get(`/api/flights?from=BOM&to=DEL&date=${day()}`);
    expect(res.status).toBe(200);
    expect(res.body.flights).toHaveLength(1);
    expect(res.body.flights[0]).toEqual({
      flightId: scheduled,
      flightNumber: expect.stringMatching(/^AI-\d+$/),
      from: 'BOM',
      to: 'DEL',
      departureTime: indiaTime(day(), 10).toISOString(),
      arrivalTime: indiaTime(day(), 12).toISOString(),
      durationMinutes: 120,
      aircraftModel: 'A320neo',
      fromPrice: '5000.00'
    });
  });

  it("interprets the date in the source airport's timezone (IST day boundaries)", async () => {
    const aircraft = await createAircraft(admin);
    const last = new Date(indiaTime(day(), 0).getTime() + 24 * 3_600_000 - 60_000); // 23:59 IST
    const nextMidnight = new Date(last.getTime() + 60_000); // 00:00 IST next day
    const firstMinute = indiaTime(day(), 0); // 00:00 IST on the day
    const beforeStart = new Date(firstMinute.getTime() - 60_000); // 23:59 IST the day before
    const ids = {
      last: await scheduledFlight(aircraft.id, { departureTime: last }),
      first: await scheduledFlight(aircraft.id, { departureTime: firstMinute }),
      next: await scheduledFlight(aircraft.id, { departureTime: nextMidnight }),
      before: await scheduledFlight(aircraft.id, { departureTime: beforeStart })
    };
    const res = await client(app).get(`/api/flights?from=BOM&to=DEL&date=${day()}`);
    const found = res.body.flights.map((f: { flightId: number }) => f.flightId);
    expect(found).toEqual([ids.first, ids.last]);
    expect(found).not.toContain(ids.next);
    expect(found).not.toContain(ids.before);
  });

  it('sorts by departure (default) or price', async () => {
    const aircraft = await createAircraft(admin);
    const a = await scheduledFlight(aircraft.id, { departureTime: indiaTime(day(), 9), basePrice: '7000' });
    const b = await scheduledFlight(aircraft.id, { departureTime: indiaTime(day(), 11), basePrice: '3000' });
    const c = await scheduledFlight(aircraft.id, { departureTime: indiaTime(day(), 15), basePrice: '5000' });
    const byDeparture = await client(app).get(`/api/flights?from=BOM&to=DEL&date=${day()}`);
    expect(byDeparture.body.flights.map((f: { flightId: number }) => f.flightId)).toEqual([a, b, c]);
    const byPrice = await client(app).get(`/api/flights?from=BOM&to=DEL&date=${day()}&sort=price`);
    expect(byPrice.body.flights.map((f: { flightId: number }) => f.flightId)).toEqual([b, c, a]);
  });

  it('hides flights that depart within the 60-minute booking cutoff', async () => {
    const aircraft = await createAircraft(admin);
    const today = indiaDate(0);
    const now = Date.now();
    const soon = new Date(now + 30 * 60_000);
    const later = new Date(now + (BOOKING_CUTOFF_MINUTES + 30) * 60_000);
    // Both flights are on "today" only if they fall on the same India calendar day as `now`.
    const sameDay = (d: Date): boolean => indiaDate(0) === today && d.getTime() < indiaTime(indiaDate(1), 0).getTime();
    await scheduledFlight(aircraft.id, { departureTime: soon, flightNumber: 'AI-901' });
    await scheduledFlight(aircraft.id, { departureTime: later, flightNumber: 'AI-902' });
    const res = await client(app).get(`/api/flights?from=BOM&to=DEL&date=${today}`);
    const numbers = res.body.flights.map((f: { flightNumber: string }) => f.flightNumber);
    expect(numbers).not.toContain('AI-901');
    if (sameDay(later)) expect(numbers).toContain('AI-902'); // skipped only if the test runs just before midnight IST
  });

  it('validates the query', async () => {
    const past = indiaDate(-1);
    const tooFar = indiaDate(SEARCH_MAX_DAYS_AHEAD + 1);
    const cases: Array<[string, string]> = [
      ['same airports', `from=BOM&to=BOM&date=${day()}`],
      ['bad IATA code', `from=BOMB&to=DEL&date=${day()}`],
      ['numeric code', `from=B0M&to=DEL&date=${day()}`],
      ['missing date', 'from=BOM&to=DEL'],
      ['non-date', 'from=BOM&to=DEL&date=tomorrow'],
      ['impossible date', 'from=BOM&to=DEL&date=2026-02-30'],
      ['past date', `from=BOM&to=DEL&date=${past}`],
      ['beyond 90 days', `from=BOM&to=DEL&date=${tooFar}`],
      ['unknown airport', `from=BOM&to=XXX&date=${day()}`],
      ['bad sort', `from=BOM&to=DEL&date=${day()}&sort=cheapest`]
    ];
    for (const [label, query] of cases) {
      const res = await client(app).get(`/api/flights?${query}`);
      expect(res.status, label).toBe(400);
      expect(res.body.error.code, label).toBe('VALIDATION_ERROR');
    }
    // Boundaries that ARE allowed: today, and exactly 90 days ahead.
    expect((await client(app).get(`/api/flights?from=BOM&to=DEL&date=${indiaDate(0)}`)).status).toBe(200);
    expect((await client(app).get(`/api/flights?from=BOM&to=DEL&date=${indiaDate(SEARCH_MAX_DAYS_AHEAD)}`)).status).toBe(200);
  });

  it('accepts lowercase IATA codes', async () => {
    expect((await client(app).get(`/api/flights?from=bom&to=del&date=${day()}`)).status).toBe(200);
  });
});

describe('GET /api/flights/:flightId', () => {
  it('returns details; DRAFT flights are 404 for everyone but admins', async () => {
    const aircraft = await createAircraft(admin, { layoutColumns: 'AC-DF', totalRows: 18, businessRows: 0, model: 'ATR 72' });
    const flight = await createFlight(admin, { aircraftId: aircraft.id });

    const { http: user } = await loginAs(app, { email: 'user@example.com' });
    for (const who of [client(app), user]) {
      const res = await who.get(`/api/flights/${flight.flightId}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('FLIGHT_NOT_FOUND');
    }
    expect((await admin.get(`/api/flights/${flight.flightId}`)).status).toBe(200);

    await forceStatus(flight.flightId, 'SCHEDULED');
    const res = await client(app).get(`/api/flights/${flight.flightId}`);
    expect(res.status).toBe(200);
    expect(res.body.flight).toMatchObject({
      flightId: flight.flightId,
      status: 'SCHEDULED',
      from: 'BOM',
      to: 'DEL',
      basePrice: '5000.00',
      currency: 'INR',
      fromAirport: { code: 'BOM', city: 'Mumbai', timezone: 'Asia/Kolkata' },
      toAirport: { code: 'DEL', city: 'Delhi' },
      aircraft: { model: 'ATR 72', layoutColumns: 'AC-DF', totalRows: 18, businessRows: 0, seatCount: 72 }
    });

    // Cancelled flights remain viewable (with their status).
    await forceStatus(flight.flightId, 'CANCELLED');
    expect((await client(app).get(`/api/flights/${flight.flightId}`)).body.flight.status).toBe('CANCELLED');
  });

  it('404 for unknown ids and 400 for malformed ones', async () => {
    expect((await client(app).get('/api/flights/424242')).status).toBe(404);
    for (const bad of ['abc', '0', '-1', '1.5', '1e3']) {
      expect((await client(app).get(`/api/flights/${bad}`)).status, bad).toBe(400);
    }
  });
});

describe('flightsService.getBookability (cross-module API)', () => {
  it('reports NOT_FOUND / NOT_SCHEDULED / CUTOFF / bookable, always from the database', async () => {
    const aircraft = await createAircraft(admin);
    const now = new Date();
    const far = await createFlight(admin, { aircraftId: aircraft.id, departureTime: new Date(now.getTime() + 5 * 3_600_000) });

    expect(await flightsService.getBookability(424242)).toEqual({ bookable: false, reason: 'NOT_FOUND', snapshot: null });

    const draft = await flightsService.getBookability(far.flightId, now);
    expect(draft).toMatchObject({ bookable: false, reason: 'NOT_SCHEDULED', snapshot: { status: 'DRAFT', flightNumber: far.flightNumber } });

    await forceStatus(far.flightId, 'SCHEDULED');
    const ok = await flightsService.getBookability(far.flightId, now);
    expect(ok).toMatchObject({
      bookable: true,
      reason: null,
      snapshot: { flightNumber: far.flightNumber, from: 'BOM', to: 'DEL', status: 'SCHEDULED', departureTime: far.departureTime, arrivalTime: far.arrivalTime }
    });

    const departure = new Date(far.departureTime).getTime();
    // Exactly 60 minutes before departure is already inside the cutoff ("more than 60 min" required).
    const atCutoff = await flightsService.getBookability(far.flightId, new Date(departure - BOOKING_CUTOFF_MINUTES * 60_000));
    expect(atCutoff).toMatchObject({ bookable: false, reason: 'CUTOFF' });
    const justOutside = await flightsService.getBookability(far.flightId, new Date(departure - BOOKING_CUTOFF_MINUTES * 60_000 - 1));
    expect(justOutside.bookable).toBe(true);
    const afterDeparture = await flightsService.getBookability(far.flightId, new Date(departure + 1000));
    expect(afterDeparture).toMatchObject({ bookable: false, reason: 'CUTOFF' });

    await forceStatus(far.flightId, 'CANCELLED');
    expect(await flightsService.getBookability(far.flightId, now)).toMatchObject({ bookable: false, reason: 'NOT_SCHEDULED' });
  });

  it('getLayout returns the aircraft layout, or null for an unknown flight', async () => {
    const aircraft = await createAircraft(admin, { layoutColumns: 'AC-DF', totalRows: 18, businessRows: 0 });
    const flight = await createFlight(admin, { aircraftId: aircraft.id });
    expect(await flightsService.getLayout(flight.flightId)).toEqual({
      layoutColumns: 'AC-DF',
      columns: ['A', 'C', null, 'D', 'F'],
      totalRows: 18
    });
    expect(await flightsService.getLayout(424242)).toBeNull();
  });
});
