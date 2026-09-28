import { createHash } from 'node:crypto';
import type { AdminFlightDto, SeatDto, UserDto } from '@flight/shared';
import { authService } from '../modules/auth/index.js';
import { bookingService, holdService, seatMapService } from '../modules/booking/index.js';
import { flightsAdminService } from '../modules/flights/index.js';
import { AppError } from '../platform/errors.js';
import { moduleLogger } from '../platform/logger.js';
import { DEMO_USERS } from './data.js';
import { createRandom, hashString, randomInt, type Random } from './prng.js';

const log = moduleLogger('seed');

/** ~5 % of the seats on flights departing within the next 3 days end up booked by demo users. */
const BOOKED_SHARE = 0.05;
const DEMO_DAYS = 3;
const MAX_SEATS_PER_BOOKING = 4;
const NAMES = ['Aarav Mehta', 'Diya Nair', 'Kabir Shah', 'Isha Verma', 'Rohan Iyer', 'Meera Das', 'Vikram Rao', 'Anaya Kapoor', 'Arjun Patel', 'Sara Khan'];

export interface DemoBookingOptions {
  now?: Date;
  /** Days ahead (from now) whose flights get bookings. Default 3. */
  days?: number;
}

export interface DemoBookingResult {
  flightsConsidered: number;
  bookingsCreated: number;
  bookingsSkipped: number;
}

/** A stable, valid UUID v4 derived from a string: re-running the seed replays the same idempotency keys. */
function deterministicKey(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest();
  bytes[6] = ((bytes[6]) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8]) & 0x3f) | 0x80; // variant
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Up to `count` free seats in one row starting at a random free seat (so companions sit together). */
function pickSeats(random: Random, free: SeatDto[], count: number): SeatDto[] {
  if (free.length === 0) return [];
  const anchor = free[randomInt(random, 0, free.length - 1)];
  const sameRow = free.filter((seat) => seat.row === anchor.row);
  const from = sameRow.indexOf(anchor);
  return sameRow.slice(from, from + count);
}

async function bookAsUser(user: UserDto, flight: AdminFlightDto, seats: SeatDto[], key: string): Promise<boolean> {
  try {
    await holdService.acquire(user.id, flight.flightId, seats.map((seat) => seat.seatId));
  } catch {
    return false; // seat conflict, this user's hold quota/limit, or the flight just became unbookable
  }
  try {
    await bookingService.createBooking({
      userId: user.id,
      idempotencyKey: key,
      request: {
        flightId: flight.flightId,
        seats: seats.map((seat, i) => ({
          seatId: seat.seatId,
          passenger: { fullName: NAMES[(user.id + i) % NAMES.length], age: 18 + ((user.id * 7 + i * 3) % 53) }
        })),
        payment: { method: 'UPI', simulateOutcome: 'SUCCESS' }
      }
    });
    return true;
  } catch (error) {
    await holdService.release(user.id, flight.flightId).catch(() => undefined);
    if (error instanceof AppError) return false; // e.g. a real client raced this same seat
    throw error;
  }
}

/**
 * Books ~5 % of the seats of near-term flights as the demo users, through the REAL hold and booking
 * services (holds, idempotent claim, simulated payment, confirm transaction), so seat maps look
 * realistic and the seed exercises the same code path as production traffic.
 *
 * Flights are processed one at a time (this is a one-off local script, not a load test) and each
 * booking rotates to the next demo user, so the hourly per-user hold quota (Section 6.1) is spread
 * across all of them instead of exhausted by one. If every user is unable to hold a given batch (most
 * often because they have all hit that quota) the flight is left short of its target rather than
 * retried without bound. Idempotent: already-booked seats count toward the target, and a flight that
 * already has its share is skipped; the idempotency keys are deterministic.
 */
export async function seedDemoBookings(options: DemoBookingOptions = {}): Promise<DemoBookingResult> {
  const now = options.now ?? new Date();
  const horizon = now.getTime() + (options.days ?? DEMO_DAYS) * 86_400_000;
  const earliest = now.getTime() + 90 * 60_000;

  const users: UserDto[] = [];
  for (const demo of DEMO_USERS) {
    const user = await authService.findUserByEmail(demo.email);
    if (user !== undefined) users.push(user);
  }
  const result: DemoBookingResult = { flightsConsidered: 0, bookingsCreated: 0, bookingsSkipped: 0 };
  if (users.length === 0) {
    log.warn('no demo users found: skipping demo bookings');
    return result;
  }

  const flights: AdminFlightDto[] = [];
  let cursor: number | undefined;
  do {
    const page = await flightsAdminService.listFlights({ status: 'SCHEDULED', cursor });
    for (const flight of page.items) {
      const departure = new Date(flight.departureTime).getTime();
      if (departure > earliest && departure < horizon) flights.push(flight);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  flights.sort((a, b) => a.flightId - b.flightId);
  result.flightsConsidered = flights.length;

  let nextUser = 0;
  for (const flight of flights) {
    const inventory = await seatMapService.getInventory(flight.flightId);
    let needed = Math.round(inventory.seatCount * BOOKED_SHARE) - inventory.booked;
    if (needed <= 0) continue;

    const random = createRandom(hashString(`demo-bookings|${flight.flightId}`));
    const map = await seatMapService.getSeatMap(flight.flightId, undefined);
    const free = map.seats.filter((seat) => seat.status === 'AVAILABLE');

    let attempt = 0;
    while (needed > 0 && free.length > 0) {
      const seats = pickSeats(random, free, Math.min(needed, randomInt(random, 1, MAX_SEATS_PER_BOOKING)));
      if (seats.length === 0) break;
      for (const seat of seats) free.splice(free.indexOf(seat), 1);

      // Try each user in turn, starting from a rotating point: this spreads holds (and their hourly
      // quota) evenly, and a batch is abandoned once nobody can take it rather than retried forever.
      let booked = false;
      for (let i = 0; i < users.length && !booked; i += 1) {
        const user = users[(nextUser + i) % users.length];
        attempt += 1;
        booked = await bookAsUser(user, flight, seats, deterministicKey(`demo-booking|${flight.flightId}|${attempt}`));
      }
      nextUser = (nextUser + 1) % users.length;
      if (booked) {
        result.bookingsCreated += 1;
        needed -= seats.length;
      } else {
        result.bookingsSkipped += 1;
      }
    }
  }
  log.info({ event: 'SEED_BOOKINGS', ...result }, 'demo bookings seeded');
  return result;
}
