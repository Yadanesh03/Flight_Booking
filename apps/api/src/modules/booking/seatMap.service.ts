import type { SeatDto, SeatMapDto } from '@flight/shared';
import { AppError } from '../../platform/errors.js';
import { seatCache } from './seatCache.js';

/** Seat map (Section 15.1). */
export const seatMapService = {
  /**
   * GET /api/flights/:flightId/seats. Per seat, in this order:
   *   booked -> BOOKED; held by the caller -> HELD_BY_YOU; held by someone else -> HELD; else AVAILABLE.
   * Unknown flight or one with no inventory (e.g. still DRAFT) -> 404 FLIGHT_NOT_FOUND.
   */
  async getSeatMap(flightId: number, _userId: number | undefined): Promise<SeatMapDto> {
    const meta = await seatCache.getSeatMeta(flightId);
    if (meta === null) throw new AppError('FLIGHT_NOT_FOUND');
    const status = await seatCache.getSeatStatus(flightId);

    const seats: SeatDto[] = meta.seats.map((seat) => ({
      seatId: seat.seatId,
      seatNumber: seat.seatNumber,
      row: seat.row,
      column: seat.column,
      cabinClass: seat.cabinClass,
      seatType: seat.seatType,
      price: seat.price,
      status: status.get(seat.seatId) === 'B' ? 'BOOKED' : 'AVAILABLE'
    }));
    return {
      flightId,
      serverTime: new Date().toISOString(),
      layout: meta.layout,
      holdsUnavailable: false,
      seats
    };
  }
};
