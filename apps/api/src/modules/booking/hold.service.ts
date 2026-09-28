import {
  HOLD_ACQUISITIONS_PER_HOUR,
  MAX_FLIGHTS_WITH_ACTIVE_HOLDS,
  MAX_SEATS_PER_FLIGHT_HOLD,
  type HoldDto,
  type HoldsResponse
} from '@flight/shared';
import { config } from '../../platform/config.js';
import { AppError } from '../../platform/errors.js';
import { moduleLogger } from '../../platform/logger.js';
import { coordGuard, coordRedis } from '../../platform/redis.js';
import { flightsService } from '../flights/index.js';
import { seatCache, type SeatMapMeta } from './seatCache.js';

const log = moduleLogger('booking');

const HOUR_MS = 3_600_000;
/** `bs:holdquota:<userId>:<hourIndex>` lives a bit longer than the hour it counts. */
const QUOTA_KEY_TTL_SECONDS = 7200;

/** Keys owned by the booking module in redis-coord (Section 9.1). */
export const holdsKey = (flightId: number): string => `bs:holds:${flightId}`;
export const userHoldsKey = (userId: number): string => `bs:userholds:${userId}`;
const quotaKey = (userId: number, hourIndex: number): string => `bs:holdquota:${userId}:${hourIndex}`;

/** Hash value written by holdAcquire.lua: `"<userId>|<expiresAtMs>"`. */
export function parseHoldValue(value: string): { userId: number; expiresAtMs: number } {
  const separator = value.indexOf('|');
  return { userId: Number(value.slice(0, separator)), expiresAtMs: Number(value.slice(separator + 1)) };
}

async function requireBookableFlightWithSeats(flightId: number): Promise<SeatMapMeta> {
  const meta = await seatCache.getSeatMeta(flightId);
  if (meta !== null) return meta;
  // No inventory: either the flight does not exist or it is not published.
  const { reason } = await flightsService.getBookability(flightId);
  throw new AppError(reason === 'NOT_FOUND' || reason === null ? 'FLIGHT_NOT_FOUND' : 'FLIGHT_NOT_BOOKABLE');
}

function secondsUntilNextHour(now: number): number {
  return Math.max(1, Math.ceil((HOUR_MS - (now % HOUR_MS)) / 1000));
}

/**
 * Seat holds (Section 15.2-15.4). Holds live only in redis-coord: they are created atomically by
 * Lua, expire by per-field TTL, and are never extended. When redis-coord is unavailable every
 * operation here fails with 503 SERVICE_DEGRADED: holds are refused rather than granted without
 * coordination (invariant 9).
 */
export const holdService = {
  /**
   * PUT /api/flights/:flightId/holds. `seatIds` is the user's FULL desired set for this flight
   * (replace semantics). All-or-nothing; seats already held by the user keep their original expiry.
   */
  async acquire(userId: number, flightId: number, seatIds: number[]): Promise<HoldsResponse> {
    // 1. Every seat must belong to this flight.
    const meta = await requireBookableFlightWithSeats(flightId);
    const known = new Map(meta.seats.map((seat) => [seat.seatId, seat] as const));
    const foreign = seatIds.filter((id) => !known.has(id));
    if (foreign.length > 0) {
      throw new AppError('VALIDATION_ERROR', {
        details: { issues: [{ path: 'seatIds', message: 'Some seats do not belong to this flight.' }], seatIds: foreign }
      });
    }

    // 2. The flight must be bookable right now (fresh DB read, never cached).
    const bookability = await flightsService.getBookability(flightId);
    if (!bookability.bookable) {
      throw new AppError(bookability.reason === 'NOT_FOUND' ? 'FLIGHT_NOT_FOUND' : 'FLIGHT_NOT_BOOKABLE');
    }

    // 3. Seats already BOOKED are rejected up front. A stale cache here is harmless: the booking
    //    transaction is the final check.
    const status = await seatCache.getSeatStatus(flightId);
    const booked = seatIds.filter((id) => status.get(id) === 'B');
    if (booked.length > 0) throw new AppError('SEAT_UNAVAILABLE', { details: { seatIds: booked } });

    // 4. Hourly acquisition quota: only NEWLY acquired seats count (ones already held by this user don't).
    const now = Date.now();
    const hourIndex = Math.floor(now / HOUR_MS);
    const [alreadyHeld, used] = await coordGuard(async () => {
      const values = await coordRedis.hmget(holdsKey(flightId), ...seatIds.map(String));
      const mine = values.filter((value) => value !== null && parseHoldValue(value).userId === userId).length;
      return [mine, Number((await coordRedis.get(quotaKey(userId, hourIndex))) ?? 0)] as const;
    });
    const newlyAcquired = seatIds.length - alreadyHeld;
    if (used + newlyAcquired > HOLD_ACQUISITIONS_PER_HOUR) {
      throw new AppError('HOLD_QUOTA_EXCEEDED', {
        details: { limit: HOLD_ACQUISITIONS_PER_HOUR, used },
        retryAfterSeconds: secondsUntilNextHour(now)
      });
    }

    // 5. The atomic hold script.
    const [outcome = '', ...rest] = await coordGuard(() =>
      coordRedis.holdAcquire(
        holdsKey(flightId),
        userHoldsKey(userId),
        String(userId),
        String(flightId),
        config.holdTtlSeconds,
        MAX_SEATS_PER_FLIGHT_HOLD,
        MAX_FLIGHTS_WITH_ACTIVE_HOLDS,
        ...seatIds.map(String)
      )
    );

    if (outcome === 'CONFLICT') {
      const conflicting = rest.map(Number);
      log.info({ event: 'SEAT_HOLD_CONFLICT', userId, flightId, seatIds: conflicting }, 'SEAT_HOLD_CONFLICT');
      throw new AppError('SEAT_TEMPORARILY_UNAVAILABLE', { details: { seatIds: conflicting } });
    }
    if (outcome === 'SEAT_LIMIT' || outcome === 'FLIGHT_LIMIT') {
      const limit = outcome === 'SEAT_LIMIT' ? MAX_SEATS_PER_FLIGHT_HOLD : MAX_FLIGHTS_WITH_ACTIVE_HOLDS;
      log.info({ event: 'SEAT_HOLD_LIMIT', userId, flightId, kind: outcome }, 'SEAT_HOLD_LIMIT');
      throw new AppError('HOLD_LIMIT_EXCEEDED', {
        details: { limit, kind: outcome === 'SEAT_LIMIT' ? 'SEATS_PER_FLIGHT' : 'FLIGHTS' }
      });
    }
    if (outcome !== 'OK') throw new Error(`unexpected holdAcquire result: ${outcome}`);

    // 6. Count the newly added seats against the hourly quota.
    const added = Number(rest[0] ?? 0);
    if (added > 0) {
      await coordGuard(async () => {
        const key = quotaKey(userId, hourIndex);
        await coordRedis.multi().incrby(key, added).expire(key, QUOTA_KEY_TTL_SECONDS).exec();
      });
    }
    log.info({ event: 'SEAT_HOLD_ACQUIRED', userId, flightId, seats: seatIds.length, added }, 'SEAT_HOLD_ACQUIRED');

    // The response lists every seat the user now holds on this flight, each with its ORIGINAL expiry.
    const values = await coordGuard(() => coordRedis.hmget(holdsKey(flightId), ...seatIds.map(String)));
    const holds: HoldDto[] = [];
    seatIds.forEach((seatId, index) => {
      const value = values[index];
      if (value === null || value === undefined) return; // expired in the instant since (sub-second TTLs in tests)
      holds.push({
        flightId,
        seatId,
        seatNumber: (known.get(seatId) as { seatNumber: string }).seatNumber,
        expiresAt: new Date(parseHoldValue(value).expiresAtMs).toISOString()
      });
    });
    return { holds, serverTime: new Date().toISOString() };
  },

  /** DELETE /api/flights/:flightId/holds: releases all of the user's seats on that flight. */
  async release(userId: number, flightId: number): Promise<void> {
    const released = await coordGuard(() => coordRedis.holdRelease(holdsKey(flightId), userHoldsKey(userId), String(userId), String(flightId)));
    log.info({ event: 'SEAT_HOLD_RELEASED', userId, flightId, released }, 'SEAT_HOLD_RELEASED');
  },

  /** GET /api/holds: the user's active holds across flights, so checkout can resume after a refresh. */
  async list(userId: number): Promise<HoldsResponse> {
    const fields = await coordGuard(() => coordRedis.hgetall(userHoldsKey(userId)));
    const now = Date.now();
    const byFlight = new Map<number, Array<{ seatId: number; expiresAtMs: number }>>();
    for (const [field, expiresAt] of Object.entries(fields)) {
      const [flightId, seatId] = field.split(':').map(Number) as [number, number];
      const expiresAtMs = Number(expiresAt);
      if (expiresAtMs <= now) continue; // defensive: a field that expired but was not yet removed
      byFlight.set(flightId, [...(byFlight.get(flightId) ?? []), { seatId, expiresAtMs }]);
    }

    const holds: HoldDto[] = [];
    for (const flightId of [...byFlight.keys()].sort((a, b) => a - b)) {
      const meta = await seatCache.getSeatMeta(flightId);
      const seatNumbers = new Map((meta?.seats ?? []).map((seat) => [seat.seatId, seat.seatNumber] as const));
      const order = new Map((meta?.seats ?? []).map((seat, index) => [seat.seatId, index] as const));
      const entries = (byFlight.get(flightId) ?? []).sort((a, b) => (order.get(a.seatId) ?? 0) - (order.get(b.seatId) ?? 0));
      for (const { seatId, expiresAtMs } of entries) {
        holds.push({ flightId, seatId, seatNumber: seatNumbers.get(seatId) ?? String(seatId), expiresAt: new Date(expiresAtMs).toISOString() });
      }
    }
    return { holds, serverTime: new Date(now).toISOString() };
  },

  /**
   * Booking Phase B step 5 (Section 15.5): every seat must currently be held by THIS user, checked on
   * the server at payment time (invariant 4). Throws 409 HOLD_EXPIRED otherwise, or 503
   * SERVICE_DEGRADED when redis-coord is unreachable.
   */
  async verifyHeld(userId: number, flightId: number, seatIds: number[]): Promise<void> {
    const values = await coordGuard(() => coordRedis.hmget(holdsKey(flightId), ...seatIds.map(String)));
    const allMine = values.every((value) => value !== null && parseHoldValue(value).userId === userId);
    if (!allMine) throw new AppError('HOLD_EXPIRED');
  },

  /** After a successful booking: release exactly the booked seats. Best effort (see the caller). */
  async releaseBooked(userId: number, flightId: number, seatIds: number[]): Promise<void> {
    await coordRedis.holdRelease(holdsKey(flightId), userHoldsKey(userId), String(userId), String(flightId), ...seatIds.map(String));
  },

  /** All currently held seats of a flight with their holder (expired holds are never returned). */
  async holdsForFlight(flightId: number): Promise<Map<number, { userId: number; expiresAtMs: number }>> {
    const hash = await coordRedis.hgetall(holdsKey(flightId));
    return new Map(Object.entries(hash).map(([seatId, value]) => [Number(seatId), parseHoldValue(value)] as const));
  }
};
