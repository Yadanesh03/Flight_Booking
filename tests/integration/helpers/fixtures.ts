import type { Express } from 'express';
import { sql } from 'drizzle-orm';
import { BCRYPT_COST, type AdminFlightDto, type AircraftDto, type AirportDto, type UserDto } from '@flight/shared';
import bcrypt from 'bcrypt';
import { sessionService } from '../../../apps/api/src/modules/auth/index.js';
import { catalogService } from '../../../apps/api/src/modules/flights/index.js';
import { db } from '../../../apps/api/src/platform/db.js';
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
}

export async function scalar<T = number>(query: ReturnType<typeof sql>): Promise<T> {
  const [rows] = (await db.execute(query)) as unknown as [Array<Record<string, T>>];
  const first = rows[0];
  if (first === undefined) throw new Error('scalar(): no rows');
  return Object.values(first)[0];
}
