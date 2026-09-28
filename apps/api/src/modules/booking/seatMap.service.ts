import type { AdminInventoryDto, SeatDto, SeatMapDto } from '@flight/shared';
import { db } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import { moduleLogger } from '../../platform/logger.js';
import { coordGuard } from '../../platform/redis.js';
import { flightSeatsRepository } from './flightSeats.repository.js';
import { holdService } from './hold.service.js';
import { seatCache } from './seatCache.js';

const log = moduleLogger('booking');

/** Seat map (Section 15.1) and the admin inventory view (Section 15.9). */
export const seatMapService = {
  /**
   * GET /api/flights/:flightId/seats. Per seat, in this order:
   *   booked -> BOOKED; held by the caller -> HELD_BY_YOU (+ expiry); held by someone else -> HELD
   *   ("temporarily unavailable"); otherwise AVAILABLE.
   * Unknown flight or one with no inventory (e.g. still DRAFT) -> 404 FLIGHT_NOT_FOUND.
   * If redis-coord is down the seats are returned WITHOUT hold information and `holdsUnavailable: true`.
   */
  async getSeatMap(flightId: number, userId: number | undefined): Promise<SeatMapDto> {
    const meta = await seatCache.getSeatMeta(flightId);
    if (meta === null) throw new AppError('FLIGHT_NOT_FOUND');
    const status = await seatCache.getSeatStatus(flightId);

    let holds: Awaited<ReturnType<typeof holdService.holdsForFlight>> = new Map();
    let holdsUnavailable = false;
    try {
      holds = await holdService.holdsForFlight(flightId);
    } catch (error) {
      holdsUnavailable = true;
      log.warn({ event: 'HOLDS_UNAVAILABLE', flightId, err: error instanceof Error ? error.message : String(error) }, 'seat map served without hold information');
    }

    const seats: SeatDto[] = meta.seats.map((seat) => {
      const base = {
        seatId: seat.seatId,
        seatNumber: seat.seatNumber,
        row: seat.row,
        column: seat.column,
        cabinClass: seat.cabinClass,
        seatType: seat.seatType,
        price: seat.price
      };
      if (status.get(seat.seatId) === 'B') return { ...base, status: 'BOOKED' };
      const hold = holds.get(seat.seatId);
      if (hold === undefined) return { ...base, status: 'AVAILABLE' };
      if (userId !== undefined && hold.userId === userId) {
        return { ...base, status: 'HELD_BY_YOU', holdExpiresAt: new Date(hold.expiresAtMs).toISOString() };
      }
      return { ...base, status: 'HELD' };
    });

    return { flightId, serverTime: new Date().toISOString(), layout: meta.layout, holdsUnavailable, seats };
  },

  /** GET /api/admin/inventory/flights/:flightId -> `{ seatCount, booked, available, heldNow }`. */
  async getInventory(flightId: number): Promise<AdminInventoryDto> {
    const { total, booked } = await flightSeatsRepository.counts(db, flightId);
    if (total === 0) throw new AppError('FLIGHT_NOT_FOUND');
    const heldNow = (await coordGuard(() => holdService.holdsForFlight(flightId))).size;
    return { seatCount: total, booked, available: total - booked, heldNow };
  }
};
