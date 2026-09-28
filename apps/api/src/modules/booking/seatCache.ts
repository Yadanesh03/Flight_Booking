import type { CabinClass, SeatType } from '@flight/shared';
import { db } from '../../platform/db.js';
import { flightsService } from '../flights/index.js';
import { flightSeatsRepository } from './flightSeats.repository.js';

export interface SeatMeta {
  seatId: number;
  seatNumber: string;
  row: number;
  column: string;
  cabinClass: CabinClass;
  seatType: SeatType;
  price: string;
}

/** Layout + seat metadata + prices: immutable after publish. */
export interface SeatMapMeta {
  layout: { rows: number; columns: Array<string | null> };
  seats: SeatMeta[];
}

/** `A` = available, `B` = booked. */
export type SeatStatusMap = Map<number, 'A' | 'B'>;

/** Reads `flight_seats` for the flight plus the aircraft layout. Null when the flight has no inventory. */
async function loadSeatMeta(flightId: number): Promise<SeatMapMeta | null> {
  const rows = await flightSeatsRepository.listByFlight(db, flightId);
  if (rows.length === 0) return null;
  const layout = await flightsService.getLayout(flightId);
  if (layout === null) return null;
  return {
    layout: { rows: layout.totalRows, columns: layout.columns },
    seats: rows.map((row) => ({
      seatId: row.id,
      seatNumber: row.seatNumber,
      row: row.rowNo,
      column: row.columnCode,
      cabinClass: row.cabinClass,
      seatType: row.seatType,
      price: row.price
    }))
  };
}

async function loadSeatStatus(flightId: number): Promise<SeatStatusMap> {
  const rows = await flightSeatsRepository.listStatuses(db, flightId);
  return new Map(rows.map((row) => [row.id, row.status === 'BOOKED' ? ('B' as const) : ('A' as const)]));
}

/** Seat metadata and status readers used by the seat map and the hold service. */
export const seatCache = {
  getSeatMeta: loadSeatMeta,
  getSeatStatus: loadSeatStatus
};
