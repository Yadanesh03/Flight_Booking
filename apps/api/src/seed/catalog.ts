import type { AdminFlightDto, FlightCreateInput } from '@flight/shared';
import { authService } from '../modules/auth/index.js';
import { catalogService, flightsAdminService } from '../modules/flights/index.js';
import { AppError } from '../platform/errors.js';
import { moduleLogger } from '../platform/logger.js';
import { addDays, dateInZone, zonedMidnightUtc } from '../platform/time.js';
import { AIRCRAFT, AIRPORTS, ATR_AIRCRAFT_CODE, DEMO_USERS, JET_AIRCRAFT_CODES, ROUTES, type RouteSpec } from './data.js';
import { createRandom, hashString, randomInt } from './prng.js';

const log = moduleLogger('seed');

/** Fixed seed: the same routes/slots/prices come out on every run. */
const SEED = 20_260_928;
const SLOTS_PER_ROUTE = 3;
/** Per-day flight count weights for 1, 2 and 3 flights: mean ~1.65, so ~20 routes x 14 days ~ 460 flights. */
const COUNT_WEIGHTS = [0.5, 0.35, 0.15];
/** Flights must be publishable (future) and bookable (beyond the 60-minute cutoff) when seeded. */
const MIN_LEAD_MINUTES = 90;

interface Slot {
  flightNumber: string;
  /** Minutes after local midnight (IST). */
  departureMinute: number;
  aircraftCode: string;
  basePrice: string;
}

/** The (up to 3) recurring daily schedule slots of one route: the same flight number flies daily. */
function slotsForRoute(route: RouteSpec, routeIndex: number): Slot[] {
  const random = createRandom(SEED + routeIndex * 7919);
  const slots: Slot[] = [];
  for (let k = 0; k < SLOTS_PER_ROUTE; k += 1) {
    const departureMinute = randomInt(random, 6, 22) * 60 + randomInt(random, 0, 3) * 15;
    const price = randomInt(random, 300, 900) * 10; // 3,000 - 9,000, multiples of 10
    // The ATR 72 only flies the short routes (and takes the first slot there); jets rotate otherwise.
    const aircraftCode =
      route.short === true && k === 0 ? ATR_AIRCRAFT_CODE : (JET_AIRCRAFT_CODES[(routeIndex + k) % JET_AIRCRAFT_CODES.length]);
    slots.push({
      flightNumber: `${route.prefix}-${100 + routeIndex * 10 + k}`,
      departureMinute,
      aircraftCode,
      basePrice: price.toFixed(2)
    });
  }
  // Distinct departure minutes per route-day so (flight_number, departure_time) stays unique anyway.
  return slots.sort((a, b) => a.departureMinute - b.departureMinute);
}

function flightsPerDay(routeIndex: number, date: string): number {
  const random = createRandom(SEED ^ hashString(`${routeIndex}|${date}`));
  const roll = random();
  let cumulative = 0;
  for (let i = 0; i < COUNT_WEIGHTS.length; i += 1) {
    cumulative += COUNT_WEIGHTS[i];
    if (roll < cumulative) return i + 1;
  }
  return COUNT_WEIGHTS.length;
}

export interface CatalogSeedOptions {
  /** Number of days to schedule, starting today (IST). Default 14. */
  days?: number;
  /** Also create the demo users. Default true (the CLI turns this off in production). */
  demoUsers?: boolean;
  adminEmail?: string | undefined;
  adminPassword?: string | undefined;
  now?: Date;
}

export interface CatalogSeedResult {
  usersCreated: number;
  aircraftCreated: number;
  flightsCreated: number;
  flightsPublished: number;
  flightsTotal: number;
}

async function ensureUser(user: { name: string; email: string; password: string; role?: 'USER' | 'ADMIN' }): Promise<boolean> {
  try {
    await authService.createUser(user);
    return true;
  } catch (error) {
    if (error instanceof AppError && error.code === 'EMAIL_TAKEN') return false;
    throw error;
  }
}

/**
 * Loads users, airports, aircraft and ~2 weeks of flights. Idempotent (existing records are
 * skipped) and it goes through the module services, so every business rule applies. Flights are
 * created as DRAFT and then published through the real publish transaction.
 */
export async function seedCatalog(options: CatalogSeedOptions = {}): Promise<CatalogSeedResult> {
  const now = options.now ?? new Date();
  const days = options.days ?? 14;
  const result: CatalogSeedResult = { usersCreated: 0, aircraftCreated: 0, flightsCreated: 0, flightsPublished: 0, flightsTotal: 0 };

  // Users
  if (options.adminEmail !== undefined && options.adminPassword !== undefined) {
    if (await ensureUser({ name: 'Admin', email: options.adminEmail.trim().toLowerCase(), password: options.adminPassword, role: 'ADMIN' })) {
      result.usersCreated += 1;
    }
  } else {
    log.warn('SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set: no admin user created');
  }
  if (options.demoUsers !== false) {
    for (const user of DEMO_USERS) if (await ensureUser(user)) result.usersCreated += 1;
  }

  // Airports and aircraft
  await catalogService.ensureAirports(AIRPORTS);
  const existingAircraft = new Map((await catalogService.listAircraft()).map((a) => [a.aircraftCode, a.id] as const));
  for (const spec of AIRCRAFT) {
    if (existingAircraft.has(spec.aircraftCode)) continue;
    const created = await catalogService.createAircraft(spec);
    existingAircraft.set(created.aircraftCode, created.id);
    result.aircraftCreated += 1;
  }

  // Existing flights, so a re-run skips them (and publishes any that were left as DRAFT).
  const existing = new Map<string, AdminFlightDto>();
  let cursor: number | undefined;
  do {
    const page = await flightsAdminService.listFlights({ cursor });
    for (const flight of page.items) existing.set(`${flight.flightNumber}|${flight.departureTime}`, flight);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  const today = dateInZone('Asia/Kolkata', now);
  const earliestDeparture = now.getTime() + MIN_LEAD_MINUTES * 60_000;
  for (let dayOffset = 0; dayOffset < days; dayOffset += 1) {
    const date = addDays(today, dayOffset);
    const midnight = zonedMidnightUtc(date, 'Asia/Kolkata').getTime();
    for (const [routeIndex, route] of ROUTES.entries()) {
      const slots = slotsForRoute(route, routeIndex).slice(0, flightsPerDay(routeIndex, date));
      for (const slot of slots) {
        const departure = new Date(midnight + slot.departureMinute * 60_000);
        if (departure.getTime() < earliestDeparture) continue;
        const key = `${slot.flightNumber}|${departure.toISOString()}`;
        let flight = existing.get(key);
        if (flight === undefined) {
          const input: FlightCreateInput = {
            flightNumber: slot.flightNumber,
            aircraftId: existingAircraft.get(slot.aircraftCode) as number,
            from: route.from,
            to: route.to,
            departureTime: departure,
            arrivalTime: new Date(departure.getTime() + route.durationMinutes * 60_000),
            basePrice: slot.basePrice
          };
          flight = await flightsAdminService.createFlight(input);
          result.flightsCreated += 1;
        }
        if (flight.status === 'DRAFT') {
          await flightsAdminService.publishFlight(flight.flightId, now);
          result.flightsPublished += 1;
        }
        result.flightsTotal += 1;
      }
    }
  }
  log.info({ event: 'SEED_CATALOG', ...result }, 'catalog seeded');
  return result;
}
