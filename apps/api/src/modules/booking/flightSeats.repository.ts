import { and, asc, eq, sql } from 'drizzle-orm';
import type { Executor } from '../../platform/db.js';
import { countDbQuery } from '../../platform/testSupport.js';
import { flightSeats, type FlightSeatRow, type NewFlightSeatRow } from './schema.js';

/** Data access for per-flight seat inventory. No business rules here. */
export const flightSeatsRepository = {
  /** Bulk insert in chunks so a statement stays well under max_allowed_packet. */
  async insertMany(executor: Executor, rows: NewFlightSeatRow[]): Promise<void> {
    const chunkSize = 500;
    for (let i = 0; i < rows.length; i += chunkSize) {
      await executor.insert(flightSeats).values(rows.slice(i, i + chunkSize));
    }
  },

  /** Every seat of a flight, in aircraft order (row, then column). */
  listByFlight(executor: Executor, flightId: number): Promise<FlightSeatRow[]> {
    return executor
      .select()
      .from(flightSeats)
      .where(eq(flightSeats.flightId, flightId))
      .orderBy(asc(flightSeats.rowNo), asc(flightSeats.columnCode));
  },

  /** `id, status` for every seat of a flight: the source for the seat-status cache. */
  listStatuses(executor: Executor, flightId: number): Promise<Array<{ id: number; status: 'AVAILABLE' | 'BOOKED' }>> {
    // Counted by the stampede tests (spec test 12): a cold cache must cost exactly one query.
    countDbQuery('seatStatus');
    return executor.select({ id: flightSeats.id, status: flightSeats.status }).from(flightSeats).where(eq(flightSeats.flightId, flightId));
  },

  /** Seats of this flight matching the given ids (plain read; prices are immutable after publish). */
  listByIds(executor: Executor, flightId: number, ids: number[]): Promise<FlightSeatRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return executor
      .select()
      .from(flightSeats)
      .where(and(eq(flightSeats.flightId, flightId), sql`${flightSeats.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`))
      .orderBy(asc(flightSeats.id));
  },

  /** `{ total, booked }` for the admin inventory view. */
  async counts(executor: Executor, flightId: number): Promise<{ total: number; booked: number }> {
    const rows = await executor
      .select({
        total: sql<number>`COUNT(*)`,
        booked: sql<number>`COALESCE(SUM(${flightSeats.status} = 'BOOKED'), 0)`
      })
      .from(flightSeats)
      .where(eq(flightSeats.flightId, flightId));
    return { total: Number(rows[0]?.total ?? 0), booked: Number(rows[0]?.booked ?? 0) };
  }
};
