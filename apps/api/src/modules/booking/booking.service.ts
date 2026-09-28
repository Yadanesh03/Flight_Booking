import {
  BOOKING_IN_PROGRESS_RETRY_AFTER_S,
  BOOKING_REF_MAX_ATTEMPTS,
  BOOKING_TX_LOCK_WAIT_TIMEOUT_S,
  BOOKING_TX_MAX_RETRIES,
  BOOKING_TX_RETRY_BACKOFF_MS,
  BOOKING_TX_RETRY_JITTER_MS,
  isBookingFailureReason,
  type BookingDto,
  type BookingFailureReason,
  type BookingListQuery,
  type BookingListResponse,
  type BookingRequest
} from '@flight/shared';
import { config } from '../../platform/config.js';
import { db, withTransaction, type Executor } from '../../platform/db.js';
import { AppError, isDbUnavailable, isDuplicateKey, isForeignKeyViolation, isRetryableTxError } from '../../platform/errors.js';
import { moduleLogger } from '../../platform/logger.js';
import { sumMoney } from '../../platform/money.js';
import { SimulatedCrash, runTestHook } from '../../platform/testSupport.js';
import { flightsService, type FlightSnapshot } from '../flights/index.js';
import { generateBookingRef } from './bookingRef.js';
import { bookingsRepository } from './bookings.repository.js';
import { flightSeatsRepository } from './flightSeats.repository.js';
import { simulatePayment } from './payment.simulator.js';
import { seatCache } from './seatCache.js';
import { requestHash } from './requestHash.js';
import type { BookingRow, BookingSeatRow } from './schema.js';

const log = moduleLogger('booking');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// DTO mapping
// ---------------------------------------------------------------------------

type StoredSnapshot = Pick<FlightSnapshot, 'flightNumber' | 'from' | 'to' | 'departureTime' | 'arrivalTime'>;

function readSnapshot(value: unknown): StoredSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const fields = ['flightNumber', 'from', 'to', 'departureTime', 'arrivalTime'] as const;
  if (!fields.every((field) => typeof v[field] === 'string')) return null;
  return {
    flightNumber: v['flightNumber'] as string,
    from: v['from'] as string,
    to: v['to'] as string,
    departureTime: v['departureTime'] as string,
    arrivalTime: v['arrivalTime'] as string
  };
}

/** `row.status` must be CONFIRMED or FAILED: PENDING bookings are never exposed. */
export function toBookingDto(row: BookingRow, seatRows: BookingSeatRow[]): BookingDto {
  const snapshot = readSnapshot(row.flightSnapshot);
  return {
    bookingRef: row.bookingRef,
    status: row.status === 'CONFIRMED' ? 'CONFIRMED' : 'FAILED',
    ...(row.status === 'FAILED' && row.failureReason !== null ? { failureReason: row.failureReason } : {}),
    flight: snapshot === null ? { flightId: row.flightId } : { flightId: row.flightId, ...snapshot },
    seats: seatRows.map((seat) => ({
      seatId: seat.flightSeatId,
      seatNumber: seat.seatNumber,
      price: seat.price,
      passenger: { fullName: seat.passengerName, age: seat.passengerAge }
    })),
    totalAmount: row.totalAmount,
    currency: row.currency,
    payment: { method: row.paymentMethod, reference: row.paymentRef },
    confirmedAt: row.confirmedAt === null ? null : row.confirmedAt.toISOString(),
    createdAt: row.createdAt.toISOString()
  };
}

async function loadBookingDto(executor: Executor, row: BookingRow): Promise<BookingDto> {
  return toBookingDto(row, await bookingsRepository.listSeats(executor, [row.id]));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateBookingParams {
  userId: number;
  /** Lower-cased UUID v4 from the `Idempotency-Key` header. */
  idempotencyKey: string;
  request: BookingRequest;
}

export interface CreateBookingResult {
  booking: BookingDto;
  /** True when this response replays an earlier request with the same idempotency key. */
  replayed: boolean;
}

/** Thrown inside the confirm transaction to roll it back when a seat is no longer available. */
class SeatsUnavailable extends Error {
  /**
   * @param seatIds every requested seat that could not be booked
   * @param bookedIds the subset MySQL reports as BOOKED (the seat-status cache is repaired for these)
   */
  constructor(
    readonly seatIds: number[],
    readonly bookedIds: number[]
  ) {
    super('seats unavailable');
  }
}

interface ClaimedBooking {
  bookingId: number;
  bookingRef: string;
}

// ---------------------------------------------------------------------------
// Phase A: claim the idempotency key (autocommit insert), or replay
// ---------------------------------------------------------------------------

function failedReplayError(booking: BookingRow): AppError {
  // The original details (e.g. which seats) are not stored; the code/status/message are enough.
  const code = isBookingFailureReason(booking.failureReason) ? booking.failureReason : 'INTERNAL_ERROR';
  return new AppError(code, { headers: { 'Idempotent-Replayed': 'true' } });
}

/**
 * Replays the outcome of an earlier request that used the same `(user, Idempotency-Key)`:
 *   different body -> 422; CONFIRMED -> the same booking; FAILED -> the same error;
 *   PENDING and fresh -> 409 BOOKING_IN_PROGRESS; PENDING and stale -> abandoned, replay as FAILED.
 */
async function replay(userId: number, idempotencyKey: string, hash: string): Promise<CreateBookingResult> {
  // Two passes: the second only happens after we flipped a stale PENDING to FAILED (or lost that race).
  for (let pass = 0; pass < 2; pass += 1) {
    const found = await bookingsRepository.findByUserAndKey(db, userId, idempotencyKey);
    if (found === undefined) break;
    const { booking, ageMs } = found;

    if (booking.requestHash !== hash) throw new AppError('IDEMPOTENCY_KEY_REUSED');

    if (booking.status === 'CONFIRMED') {
      log.info({ event: 'BOOKING_IDEMPOTENT_REPLAY', userId, bookingRef: booking.bookingRef, outcome: 'CONFIRMED' }, 'BOOKING_IDEMPOTENT_REPLAY');
      return { booking: await loadBookingDto(db, booking), replayed: true };
    }
    if (booking.status === 'FAILED') {
      log.info({ event: 'BOOKING_IDEMPOTENT_REPLAY', userId, bookingRef: booking.bookingRef, outcome: booking.failureReason }, 'BOOKING_IDEMPOTENT_REPLAY');
      throw failedReplayError(booking);
    }

    // PENDING
    if (ageMs < config.pendingBookingStaleSeconds * 1000) {
      log.info({ event: 'BOOKING_IN_PROGRESS', userId, bookingRef: booking.bookingRef }, 'BOOKING_IN_PROGRESS');
      throw new AppError('BOOKING_IN_PROGRESS', { retryAfterSeconds: BOOKING_IN_PROGRESS_RETRY_AFTER_S });
    }
    // Crash recovery without workers: the process that claimed it is presumed dead. Seats were never
    // touched (Phase C is one transaction), holds expire on their own TTL.
    await bookingsRepository.markFailed(db, booking.id, 'BOOKING_ABANDONED');
  }
  // Only reachable if the row vanished, which nothing in the system does.
  throw new AppError('INTERNAL_ERROR');
}

async function claim(params: CreateBookingParams, hash: string): Promise<ClaimedBooking | CreateBookingResult> {
  const { userId, idempotencyKey, request } = params;
  for (let attempt = 1; attempt <= BOOKING_REF_MAX_ATTEMPTS; attempt += 1) {
    const bookingRef = generateBookingRef();
    try {
      const bookingId = await bookingsRepository.insertClaim(db, {
        bookingRef,
        userId,
        flightId: request.flightId,
        idempotencyKey,
        requestHash: hash,
        paymentMethod: request.payment.method
      });
      log.info({ event: 'BOOKING_CLAIMED', userId, flightId: request.flightId, bookingRef }, 'BOOKING_CLAIMED');
      return { bookingId, bookingRef };
    } catch (error) {
      // The unique index serialises concurrent duplicates: exactly one request claims the key.
      if (isDuplicateKey(error, 'uq_user_idempotency')) return replay(userId, idempotencyKey, hash);
      if (isDuplicateKey(error, 'uq_booking_ref')) continue; // regenerate
      if (isForeignKeyViolation(error)) throw new AppError('FLIGHT_NOT_FOUND');
      throw error;
    }
  }
  log.error({ event: 'BOOKING_REF_EXHAUSTED', userId }, 'could not generate a unique booking reference');
  throw new AppError('INTERNAL_ERROR');
}

function isClaimed(value: ClaimedBooking | CreateBookingResult): value is ClaimedBooking {
  return 'bookingId' in value;
}

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

function failureReasonFor(error: unknown): BookingFailureReason {
  if (error instanceof AppError) return isBookingFailureReason(error.code) ? error.code : 'INTERNAL_ERROR';
  if (isDbUnavailable(error)) return 'SERVICE_UNAVAILABLE';
  return 'INTERNAL_ERROR';
}

/** `UPDATE bookings SET status='FAILED', failure_reason=? WHERE id=? AND status='PENDING'`. Never throws. */
async function markFailed(claimed: ClaimedBooking, reason: BookingFailureReason, userId: number): Promise<void> {
  try {
    await bookingsRepository.markFailed(db, claimed.bookingId, reason);
    log.warn({ event: 'BOOKING_FAILED', userId, bookingRef: claimed.bookingRef, reason }, 'BOOKING_FAILED');
  } catch (error) {
    // The booking stays PENDING and is recovered by the stale-PENDING rule on the next replay.
    log.error({ err: error, bookingRef: claimed.bookingRef }, 'could not mark booking FAILED');
  }
}

// ---------------------------------------------------------------------------
// Phase C: the short, locked confirm transaction
// ---------------------------------------------------------------------------

interface ConfirmArgs {
  claimed: ClaimedBooking;
  request: BookingRequest;
  seatIds: number[];
  seatsById: Map<number, { seatNumber: string; price: string }>;
  totalAmount: string;
  paymentRef: string;
  snapshot: StoredSnapshot;
}

async function runConfirmTransaction(args: ConfirmArgs): Promise<void> {
  const { claimed, request, seatIds, seatsById, totalAmount, paymentRef, snapshot } = args;
  await withTransaction(
    async (tx) => {
      // 1. Lock the seats in id order (consistent lock order prevents deadlocks).
      const locked = await flightSeatsRepository.lockForUpdate(tx, request.flightId, seatIds);
      await runTestHook('afterSeatLock');
      const lockedIds = new Set(locked.map((seat) => seat.id));
      const booked = locked.filter((seat) => seat.status !== 'AVAILABLE').map((seat) => seat.id);
      const notAvailable = [...booked, ...seatIds.filter((id) => !lockedIds.has(id))];
      if (notAvailable.length > 0) throw new SeatsUnavailable(notAvailable, booked);

      // 2. Flip them. The status guard plus the affected-row count is a second check under the lock.
      const changed = await flightSeatsRepository.markBooked(tx, seatIds, claimed.bookingId);
      if (changed !== seatIds.length) throw new SeatsUnavailable(seatIds, []);
      await runTestHook('afterSeatUpdate');

      // 3. Passengers (uq_booked_seat is the schema-level backstop against double booking).
      await bookingsRepository.insertSeats(
        tx,
        request.seats.map((seat) => {
          const info = seatsById.get(seat.seatId) as { seatNumber: string; price: string };
          return {
            bookingId: claimed.bookingId,
            flightSeatId: seat.seatId,
            seatNumber: info.seatNumber,
            price: info.price,
            passengerName: seat.passenger.fullName,
            passengerAge: seat.passenger.age
          };
        })
      );

      // 4. Confirm, but only if the claim is still PENDING (it may have been abandoned meanwhile).
      const confirmed = await bookingsRepository.confirm(tx, claimed.bookingId, {
        totalAmount,
        paymentRef,
        flightSnapshot: snapshot
      });
      if (confirmed !== 1) throw new AppError('BOOKING_ABANDONED');
    },
    { lockWaitTimeoutSeconds: BOOKING_TX_LOCK_WAIT_TIMEOUT_S }
  );
}

/** Runs Phase C, retrying deadlocks (1213) and lock-wait timeouts (1205) with backoff + jitter. */
async function confirmWithRetry(args: ConfirmArgs): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await runConfirmTransaction(args);
      return;
    } catch (error) {
      if (error instanceof SeatsUnavailable) {
        // MySQL says these seats are BOOKED but a cache (or a hold) let the request through: repair the
        // seat-status cache so the seat map stops offering them.
        await updateSeatCache(args.request.flightId, error.bookedIds, args.claimed.bookingRef, 'repair');
        throw new AppError('SEAT_UNAVAILABLE', { details: { seatIds: error.seatIds } });
      }
      if (!isRetryableTxError(error)) throw error;
      if (attempt >= BOOKING_TX_MAX_RETRIES) throw new AppError('SERVICE_UNAVAILABLE', { cause: error });
      log.warn({ event: 'BOOKING_TX_RETRY', attempt: attempt + 1, bookingRef: args.claimed.bookingRef }, 'BOOKING_TX_RETRY');
      const backoff = BOOKING_TX_RETRY_BACKOFF_MS[Math.min(attempt, BOOKING_TX_RETRY_BACKOFF_MS.length - 1)] as number;
      await sleep(backoff + Math.floor(Math.random() * (BOOKING_TX_RETRY_JITTER_MS + 1)));
    }
  }
}

// ---------------------------------------------------------------------------
// Post-commit (best effort; never changes the response)
// ---------------------------------------------------------------------------

/**
 * Marks seats booked in the seat-status cache (and bumps its version). MySQL is authoritative and
 * has already committed, so a failure here only leaves the cache stale for at most the seat-status
 * TTL (10 min), and the seat map shows BOOKED ahead of HELD anyway.
 */
async function updateSeatCache(flightId: number, seatIds: number[], bookingRef: string, purpose: 'commit' | 'repair'): Promise<void> {
  try {
    await seatCache.markBooked(flightId, seatIds);
  } catch (error) {
    log.error(
      { event: 'POST_COMMIT_CACHE_UPDATE_FAILED', step: 'seatsMarkBooked', purpose, flightId, bookingRef, err: error instanceof Error ? error.message : String(error) },
      'POST_COMMIT_CACHE_UPDATE_FAILED'
    );
  }
}

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

async function runClaimedBooking(claimed: ClaimedBooking, params: CreateBookingParams): Promise<CreateBookingResult> {
  const { userId, request } = params;
  await runTestHook('afterClaim');

  // ---- Phase B: validate and pay. No DB locks are held while waiting on payment (invariant 10). ----
  const bookability = await flightsService.getBookability(request.flightId);
  if (!bookability.bookable || bookability.snapshot === null) throw new AppError('FLIGHT_NOT_BOOKABLE');
  const { status: _status, ...snapshot } = bookability.snapshot;

  const seatIds = request.seats.map((seat) => seat.seatId).sort((a, b) => a - b);
  // The client never sends prices; they come from the immutable per-flight inventory.
  const seatRows = await flightSeatsRepository.listByIds(db, request.flightId, seatIds);
  if (seatRows.length !== seatIds.length) {
    const known = new Set(seatRows.map((seat) => seat.id));
    throw new AppError('VALIDATION_ERROR', {
      details: { issues: [{ path: 'seats', message: 'Some seats do not belong to this flight.' }], seatIds: seatIds.filter((id) => !known.has(id)) }
    });
  }
  const totalAmount = sumMoney(seatRows.map((seat) => seat.price));

  const payment = await simulatePayment(request.payment.simulateOutcome);
  if (!payment.approved) {
    log.warn({ event: 'PAYMENT_DECLINED', userId, bookingRef: claimed.bookingRef }, 'PAYMENT_DECLINED');
    throw new AppError('PAYMENT_DECLINED');
  }
  log.info({ event: 'PAYMENT_APPROVED', userId, bookingRef: claimed.bookingRef, paymentRef: payment.reference }, 'PAYMENT_APPROVED');

  // ---- Phase C ----
  await confirmWithRetry({
    claimed,
    request,
    seatIds,
    seatsById: new Map(seatRows.map((seat) => [seat.id, { seatNumber: seat.seatNumber, price: seat.price }] as const)),
    totalAmount,
    paymentRef: payment.reference,
    snapshot
  });
  // Redis never marks a seat BOOKED before MySQL commits (invariant 7): this runs strictly after.
  await updateSeatCache(request.flightId, seatIds, claimed.bookingRef, 'commit');
  // A success response is never produced unless COMMIT succeeded (invariant 2).
  log.info({ event: 'BOOKING_SUCCESS', userId, flightId: request.flightId, bookingRef: claimed.bookingRef, seats: seatIds.length }, 'BOOKING_SUCCESS');

  const row = await bookingsRepository.findById(db, claimed.bookingId);
  if (row === undefined) throw new Error('confirmed booking vanished');
  return { booking: await loadBookingDto(db, row), replayed: false };
}

export const bookingService = {
  /**
   * POST /api/bookings (Section 15.5). Three phases so that no DB lock is ever held during payment:
   *   A. claim the idempotency key with a PENDING row (or replay the earlier outcome);
   *   B. validate and pay;
   *   C. confirm in one short transaction with ordered row locks.
   * Any failure after the claim marks the booking FAILED with the error code, so a retry with the
   * same key gets the same answer.
   */
  async createBooking(params: CreateBookingParams): Promise<CreateBookingResult> {
    const hash = requestHash(params.request);
    const claimed = await claim(params, hash);
    if (!isClaimed(claimed)) return claimed;
    try {
      return await runClaimedBooking(claimed, params);
    } catch (error) {
      // A simulated crash (tests only) leaves the booking PENDING, exactly as a real crash would.
      if (error instanceof SimulatedCrash) throw error;
      await markFailed(claimed, failureReasonFor(error), params.userId);
      throw error;
    }
  },

  /** GET /api/bookings (Section 15.8): newest first, cursor-paginated. PENDING is never listed. */
  async listBookings(userId: number, query: BookingListQuery): Promise<BookingListResponse> {
    const rows = await bookingsRepository.listHistory(db, {
      userId,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit + 1
    });
    const page = rows.slice(0, query.limit);
    const seatRows = await bookingsRepository.listSeats(db, page.map((row) => row.id));
    const seatsByBooking = new Map<number, BookingSeatRow[]>();
    for (const seat of seatRows) seatsByBooking.set(seat.bookingId, [...(seatsByBooking.get(seat.bookingId) ?? []), seat]);
    const last = page.at(-1);
    return {
      items: page.map((row) => toBookingDto(row, seatsByBooking.get(row.id) ?? [])),
      nextCursor: rows.length > query.limit && last !== undefined ? last.id : null
    };
  },

  /**
   * GET /api/bookings/:bookingRef (Section 15.8): the owner or an ADMIN. Anyone else gets 404, not
   * 403, so the endpoint cannot be used to discover which references exist.
   */
  async getBooking(bookingRef: string, viewer: { id: number; role: 'USER' | 'ADMIN' }): Promise<BookingDto> {
    const row = await bookingsRepository.findByRef(db, bookingRef);
    if (row === undefined || row.status === 'PENDING' || (row.userId !== viewer.id && viewer.role !== 'ADMIN')) {
      throw new AppError('BOOKING_NOT_FOUND');
    }
    return loadBookingDto(db, row);
  }
};
