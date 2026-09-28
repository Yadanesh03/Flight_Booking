import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { BookingFailureReason, BookingListStatus, PaymentMethod } from '@flight/shared';
import type { Executor } from '../../platform/db.js';
import { bookingSeats, bookings, type BookingRow, type BookingSeatRow, type NewBookingSeatRow } from './schema.js';

/** Data access for bookings. No business rules here. */

export interface ClaimValues {
  bookingRef: string;
  userId: number;
  flightId: number;
  idempotencyKey: string;
  requestHash: string;
  paymentMethod: PaymentMethod;
}

export interface BookingWithAge {
  booking: BookingRow;
  /** Age of the row according to the DATABASE clock, so app/DB clock skew cannot misjudge staleness. */
  ageMs: number;
}

export interface ConfirmValues {
  totalAmount: string;
  paymentRef: string;
  flightSnapshot: Record<string, unknown>;
}

export interface HistoryParams {
  userId: number;
  status: BookingListStatus;
  cursor: number | undefined;
  /** Rows to fetch (callers pass page size + 1 to detect a next page). */
  limit: number;
}

function affected(result: [{ affectedRows: number }, ...unknown[]]): number {
  return result[0].affectedRows;
}

export const bookingsRepository = {
  /** Phase A claim: autocommit insert of a PENDING booking. Throws ER_DUP_ENTRY on a key collision. */
  async insertClaim(executor: Executor, values: ClaimValues): Promise<number> {
    const [result] = await executor.insert(bookings).values({ ...values, status: 'PENDING' });
    return result.insertId;
  },

  async findById(executor: Executor, id: number): Promise<BookingRow | undefined> {
    const rows = await executor.select().from(bookings).where(eq(bookings.id, id)).limit(1);
    return rows[0];
  },

  async findByRef(executor: Executor, bookingRef: string): Promise<BookingRow | undefined> {
    const rows = await executor.select().from(bookings).where(eq(bookings.bookingRef, bookingRef)).limit(1);
    return rows[0];
  },

  async findByUserAndKey(executor: Executor, userId: number, idempotencyKey: string): Promise<BookingWithAge | undefined> {
    const rows = await executor
      .select({
        booking: bookings,
        ageMs: sql<string>`TIMESTAMPDIFF(MICROSECOND, ${bookings.createdAt}, NOW(3)) DIV 1000`
      })
      .from(bookings)
      .where(and(eq(bookings.userId, userId), eq(bookings.idempotencyKey, idempotencyKey)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? undefined : { booking: row.booking, ageMs: Number(row.ageMs) };
  },

  /** PENDING -> FAILED. Returns the affected row count (0 if it was no longer PENDING). */
  async markFailed(executor: Executor, id: number, reason: BookingFailureReason): Promise<number> {
    const result = await executor
      .update(bookings)
      .set({ status: 'FAILED', failureReason: reason })
      .where(and(eq(bookings.id, id), eq(bookings.status, 'PENDING')));
    return affected(result);
  },

  /** PENDING -> CONFIRMED inside the confirm transaction. Returns the affected row count (must be 1). */
  async confirm(executor: Executor, id: number, values: ConfirmValues): Promise<number> {
    const result = await executor
      .update(bookings)
      .set({
        status: 'CONFIRMED',
        totalAmount: values.totalAmount,
        paymentRef: values.paymentRef,
        flightSnapshot: values.flightSnapshot,
        confirmedAt: sql`NOW(3)`
      })
      .where(and(eq(bookings.id, id), eq(bookings.status, 'PENDING')));
    return affected(result);
  },

  async insertSeats(executor: Executor, rows: NewBookingSeatRow[]): Promise<void> {
    await executor.insert(bookingSeats).values(rows);
  },

  listSeats(executor: Executor, bookingIds: number[]): Promise<BookingSeatRow[]> {
    if (bookingIds.length === 0) return Promise.resolve([]);
    return executor.select().from(bookingSeats).where(inArray(bookingSeats.bookingId, bookingIds)).orderBy(bookingSeats.bookingId, bookingSeats.flightSeatId);
  },

  /** Newest first. PENDING bookings are never listed. `cursor` is the smallest id of the previous page. */
  listHistory(executor: Executor, params: HistoryParams): Promise<BookingRow[]> {
    const statuses = params.status === 'ALL' ? (['CONFIRMED', 'FAILED'] as const) : ([params.status] as const);
    return executor
      .select()
      .from(bookings)
      .where(
        and(
          eq(bookings.userId, params.userId),
          inArray(bookings.status, [...statuses]),
          params.cursor === undefined ? undefined : lt(bookings.id, params.cursor)
        )
      )
      .orderBy(desc(bookings.id))
      .limit(params.limit);
  }
};
