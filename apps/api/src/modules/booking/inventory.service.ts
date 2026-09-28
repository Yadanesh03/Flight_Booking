import type { CabinClass, SeatType } from '@flight/shared';
import type { Executor } from '../../platform/db.js';
import { flightSeatsRepository } from './flightSeats.repository.js';

/** One seat to add to a flight's inventory. `seatId` is `seats.id` (the physical seat). */
export interface InventorySeat {
  seatId: number;
  seatNumber: string;
  rowNo: number;
  columnCode: string;
  cabinClass: CabinClass;
  seatType: SeatType;
  /** Decimal string, e.g. "5849.00". Computed by the flights module; immutable after publish. */
  price: string;
}

/**
 * Public API of the booking module for the flights module (Section 3.3, 15.10).
 *
 * Creates `flight_seats` rows inside the CALLER's transaction: flights' publish uses this so that
 * the inventory and the DRAFT -> SCHEDULED status change commit or roll back together (invariant 11).
 */
export const inventoryService = {
  async createInventory(tx: Executor, flightId: number, seats: InventorySeat[]): Promise<void> {
    await flightSeatsRepository.insertMany(
      tx,
      seats.map((seat) => ({
        flightId,
        seatId: seat.seatId,
        seatNumber: seat.seatNumber,
        rowNo: seat.rowNo,
        columnCode: seat.columnCode,
        cabinClass: seat.cabinClass,
        seatType: seat.seatType,
        price: seat.price,
        status: 'AVAILABLE' as const
      }))
    );
  }
};
