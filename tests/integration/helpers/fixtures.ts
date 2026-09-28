import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { sql } from 'drizzle-orm';
import { BCRYPT_COST, type AdminFlightDto, type AircraftDto, type AirportDto, type UserDto } from '@flight/shared';
import bcrypt from 'bcrypt';
import { sessionService } from '../../../apps/api/src/modules/auth/index.js';
import { catalogService } from '../../../apps/api/src/modules/flights/index.js';
import { db } from '../../../apps/api/src/platform/db.js';
import { cacheRedis, coordRedis } from '../../../apps/api/src/platform/redis.js';
import { addDays, dateInZone, zonedMidnightUtc } from '../../../apps/api/src/platform/time.js';
import { ORIGIN, client, type TestClient } from './testApp.js';

export const AIRPORTS: AirportDto[] = [
  { code: 'BOM', name: 'Chhatrapati Shivaji Maharaj International Airport', city: 'Mumbai', country: 'India', timezone: 'Asia/Kolkata' },
  { code: 'DEL', name: 'Indira Gandhi International Airport', city: 'Delhi', country: 'India', timezone: 'Asia/Kolkata' },
  { code: 'HYD', name: 'Rajiv Gandhi International Airport', city: 'Hyderabad', country: 'India', timezone: 'Asia/Kolkata' },
  { code: 'GOI', name: 'Manohar International Airport', city: 'Goa', country: 'India', timezone: 'Asia/Kolkata' }
];

export const PASSWORD = 'password-for-tests';

export async function seedAirports(): Promise<void> {
  await catalogService.ensureAirports(AIRPORTS);
}

let passwordHash: Promise<string> | undefined;

/**
 * Creates a user and returns a client that is already logged in. This is the fast path: the user is
 * inserted with a bcrypt cost-12 hash computed once per test process and a session is minted
 * directly, so a test pays for no bcrypt work. The real register/login flow is covered in auth.test.ts.
 */
export async function loginAs(app: Express, options: { email: string; name?: string; role?: 'USER' | 'ADMIN' }): Promise<{ http: TestClient; user: UserDto }> {
  passwordHash ??= bcrypt.hash(PASSWORD, BCRYPT_COST);
  const role = options.role ?? 'USER';
  const name = options.name ?? options.email.split('@')[0];
  await db.execute(sql`INSERT INTO users (name, email, password_hash, role) VALUES (${name}, ${options.email}, ${await passwordHash}, ${role})`);
  const id = await scalar<number>(sql`SELECT id FROM users WHERE email = ${options.email}`);
  const sid = await sessionService.create(id, role);
  return { http: client(app, ORIGIN, sid), user: { id: Number(id), name, email: options.email, role } };
}

export const loginAdmin = (app: Express, email = 'admin@example.com') => loginAs(app, { email, role: 'ADMIN' });

export interface AircraftOptions {
  aircraftCode?: string;
  model?: string;
  layoutColumns?: string;
  totalRows?: number;
  businessRows?: number;
}

let aircraftCounter = 0;

export async function createAircraft(admin: TestClient, options: AircraftOptions = {}): Promise<AircraftDto> {
  aircraftCounter += 1;
  const res = await admin.post('/api/admin/aircraft').send({
    aircraftCode: options.aircraftCode ?? `VT-T${String(aircraftCounter).padStart(3, '0')}`,
    model: options.model ?? 'A320neo',
    layoutColumns: options.layoutColumns ?? 'ABC-DEF',
    totalRows: options.totalRows ?? 6,
    businessRows: options.businessRows ?? 1
  });
  if (res.status !== 201) throw new Error(`createAircraft failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.aircraft as AircraftDto;
}

/** Local calendar date `daysFromToday` days from now in India, e.g. '2026-10-01'. */
export function indiaDate(daysFromToday: number): string {
  return addDays(dateInZone('Asia/Kolkata'), daysFromToday);
}

/** UTC instant for `hh:mm` local India time on `date` (YYYY-MM-DD). */
export function indiaTime(date: string, hh: number, mm = 0): Date {
  return new Date(zonedMidnightUtc(date, 'Asia/Kolkata').getTime() + (hh * 60 + mm) * 60_000);
}

let flightCounter = 100;

export interface FlightOptions {
  aircraftId: number;
  flightNumber?: string;
  from?: string;
  to?: string;
  departureTime?: Date;
  arrivalTime?: Date;
  basePrice?: string | number;
}

/** Creates a DRAFT flight through the admin API. Defaults to BOM->DEL departing tomorrow 10:00 IST. */
export async function createFlight(admin: TestClient, options: FlightOptions): Promise<AdminFlightDto> {
  flightCounter += 1;
  const departure = options.departureTime ?? indiaTime(indiaDate(1), 10);
  const arrival = options.arrivalTime ?? new Date(departure.getTime() + 2 * 3_600_000);
  const res = await admin.post('/api/admin/flights').send({
    flightNumber: options.flightNumber ?? `AI-${flightCounter}`,
    aircraftId: options.aircraftId,
    from: options.from ?? 'BOM',
    to: options.to ?? 'DEL',
    departureTime: departure.toISOString(),
    arrivalTime: arrival.toISOString(),
    basePrice: options.basePrice ?? '5000.00'
  });
  if (res.status !== 201) throw new Error(`createFlight failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.flight as AdminFlightDto;
}

/** Test-only shortcut used before publish exists in a test's setup: flips a flight's status in SQL. */
export async function forceStatus(flightId: number, status: 'DRAFT' | 'SCHEDULED' | 'CANCELLED'): Promise<void> {
  await db.execute(sql`UPDATE flights SET status = ${status} WHERE id = ${flightId}`);
  // Bypassing the API also bypasses its cache invalidation, so do what a real admin write does.
  await Promise.all([cacheRedis.del(`fs:flight:${flightId}`), coordRedis.incr('fs:searchver')]);
}

export async function scalar<T = number>(query: ReturnType<typeof sql>): Promise<T> {
  const [rows] = (await db.execute(query)) as unknown as [Array<Record<string, T>>];
  const first = rows[0];
  if (first === undefined) throw new Error('scalar(): no rows');
  return Object.values(first)[0];
}

// ---------------------------------------------------------------------------
// Booking helpers
// ---------------------------------------------------------------------------

export interface TestSeat {
  seatId: number;
  seatNumber: string;
  price: string;
  cabinClass: string;
  seatType: string;
}

export interface PublishedFlight {
  flightId: number;
  flightNumber: string;
  aircraftId: number;
  /** All seats in aircraft order (1A, 1B, 1C, 1D, ...). */
  seats: TestSeat[];
  seat(seatNumber: string): TestSeat;
}

/** Creates an aircraft + flight and publishes it. Defaults: 6 rows x 6 columns (36 seats), 1 business row. */
export async function publishedFlight(
  admin: TestClient,
  options: Partial<FlightOptions> & { rows?: number; businessRows?: number; layoutColumns?: string; aircraftId?: number } = {}
): Promise<PublishedFlight> {
  const aircraftId =
    options.aircraftId ??
    (await createAircraft(admin, { totalRows: options.rows ?? 6, businessRows: options.businessRows ?? 1, layoutColumns: options.layoutColumns })).id;
  const { rows: _rows, businessRows: _business, layoutColumns: _layout, aircraftId: _aircraft, ...flightOptions } = options;
  const flight = await createFlight(admin, { ...flightOptions, aircraftId });
  const published = await admin.post(`/api/admin/flights/${flight.flightId}/publish`);
  if (published.status !== 200) throw new Error(`publish failed: ${published.status} ${JSON.stringify(published.body)}`);
  const map = await admin.get(`/api/flights/${flight.flightId}/seats`);
  const seats = (map.body.seats as TestSeat[]).map((s) => ({ seatId: s.seatId, seatNumber: s.seatNumber, price: s.price, cabinClass: s.cabinClass, seatType: s.seatType }));
  return {
    flightId: flight.flightId,
    flightNumber: flight.flightNumber,
    aircraftId,
    seats,
    seat(seatNumber: string): TestSeat {
      const found = seats.find((candidate) => candidate.seatNumber === seatNumber);
      if (found === undefined) throw new Error(`no seat ${seatNumber}`);
      return found;
    }
  };
}

export interface PassengerInput {
  seatId: number;
  fullName?: string;
  age?: number;
}

export function bookingBody(
  flightId: number,
  passengers: PassengerInput[],
  payment: { method?: 'UPI' | 'CARD' | 'NETBANKING'; simulateOutcome?: 'SUCCESS' | 'DECLINED' } = {}
): Record<string, unknown> {
  return {
    flightId,
    seats: passengers.map((p, index) => ({
      seatId: p.seatId,
      passenger: { fullName: p.fullName ?? `Passenger ${index + 1}`, age: p.age ?? 30 + index }
    })),
    payment: { method: payment.method ?? 'UPI', ...(payment.simulateOutcome === undefined ? {} : { simulateOutcome: payment.simulateOutcome }) }
  };
}

export const newKey = (): string => randomUUID();

/** POST /api/bookings with an Idempotency-Key (a fresh one unless given). */
export function book(http: TestClient, body: Record<string, unknown>, key: string = newKey()) {
  return http.post('/api/bookings').set('Idempotency-Key', key).send(body);
}

let userCounter = 0;
export async function newUser(app: Express, prefix = 'user'): Promise<{ http: TestClient; user: UserDto }> {
  userCounter += 1;
  return loginAs(app, { email: `${prefix}${userCounter}-${Date.now() % 100000}@example.com` });
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A deterministic rendezvous for race tests, so ordering never depends on sleeps or machine speed.
 * Install `gate.hook` as a test hook: the first caller signals `reached` and then blocks until the
 * test calls `release()`. Later callers pass straight through.
 */
export function createGate(): { hook: () => Promise<void>; reached: Promise<void>; release: () => void } {
  let markReached!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((resolve) => (markReached = resolve));
  const opened = new Promise<void>((resolve) => (open = resolve));
  let used = false;
  return {
    reached,
    release: () => open(),
    hook: async () => {
      if (used) return;
      used = true;
      markReached();
      await opened;
    }
  };
}
