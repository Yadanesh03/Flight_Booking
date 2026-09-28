import {
  ADMIN_LIST_PAGE_SIZE,
  type AdminFlightDto,
  type AdminFlightListQuery,
  type FlightCreateInput,
  type FlightPatchInput
} from '@flight/shared';
import { db, withTransaction, type Executor } from '../../platform/db.js';
import { AppError, isDuplicateKey } from '../../platform/errors.js';
import { moduleLogger } from '../../platform/logger.js';
import { runTestHook } from '../../platform/testSupport.js';
import { validationError } from '../../platform/validation.js';
import { inventoryService } from '../booking/index.js';
import { aircraftRepository, airportsRepository, flightsRepository, type FlightWithAircraft } from './flights.repository.js';
import { toFlightSummary } from './flights.service.js';
import { computeSeatPrice } from './pricing.js';

const log = moduleLogger('flights');

export function toAdminFlight(rows: FlightWithAircraft): AdminFlightDto {
  return {
    ...toFlightSummary(rows),
    aircraftId: rows.aircraft.id,
    aircraftCode: rows.aircraft.aircraftCode,
    status: rows.flight.status,
    basePrice: rows.flight.basePrice
  };
}

interface FlightFields {
  flightNumber: string;
  aircraftId: number;
  from: string;
  to: string;
  departureTime: Date;
  arrivalTime: Date;
  basePrice: string;
}

/** Rules that need the whole flight (a PATCH may carry only one side of a pair). */
async function assertValidFlight(executor: Executor, fields: FlightFields): Promise<void> {
  if (fields.from === fields.to) throw validationError('to', 'Origin and destination must differ.');
  if (fields.arrivalTime.getTime() <= fields.departureTime.getTime()) {
    throw validationError('arrivalTime', 'Arrival must be after departure.');
  }
  if ((await aircraftRepository.findById(executor, fields.aircraftId)) === undefined) {
    throw validationError('aircraftId', 'Aircraft not found.');
  }
  const found = await airportsRepository.findByCodes(executor, [fields.from, fields.to]);
  if (!found.some((airport) => airport.code === fields.from)) throw validationError('from', 'Unknown airport.');
  if (!found.some((airport) => airport.code === fields.to)) throw validationError('to', 'Unknown airport.');
}

// DECISION: the error table (Section 17) has no "conflict" code for admin catalog data, so a
// duplicate (flight_number, departure_time) is reported as a 400 VALIDATION_ERROR.
function rethrowDuplicateFlight(error: unknown): never {
  if (isDuplicateKey(error, 'uq_flight_departure')) {
    throw validationError('flightNumber', 'A flight with this number and departure time already exists.');
  }
  throw error;
}

async function loadAdminFlight(executor: Executor, id: number): Promise<AdminFlightDto> {
  const rows = await flightsRepository.findWithAircraft(executor, id);
  if (rows === undefined) throw new AppError('FLIGHT_NOT_FOUND');
  return toAdminFlight(rows);
}

/** Admin flight management (Section 13.2, 13.3). */
export const flightsAdminService = {
  /** POST /api/admin/flights -> DRAFT. */
  async createFlight(input: FlightCreateInput): Promise<AdminFlightDto> {
    await assertValidFlight(db, input);
    try {
      const id = await flightsRepository.insert(db, {
        flightNumber: input.flightNumber,
        aircraftId: input.aircraftId,
        sourceAirport: input.from,
        destinationAirport: input.to,
        departureTime: input.departureTime,
        arrivalTime: input.arrivalTime,
        basePrice: input.basePrice,
        status: 'DRAFT'
      });
      return await loadAdminFlight(db, id);
    } catch (error) {
      return rethrowDuplicateFlight(error);
    }
  },

  /** GET /api/admin/flights?status=&cursor= (newest first). */
  async listFlights(query: AdminFlightListQuery): Promise<{ items: AdminFlightDto[]; nextCursor: number | null }> {
    const rows = await flightsRepository.listAdmin(db, {
      status: query.status,
      cursor: query.cursor,
      limit: ADMIN_LIST_PAGE_SIZE + 1
    });
    const page = rows.slice(0, ADMIN_LIST_PAGE_SIZE);
    const last = page.at(-1);
    return {
      items: page.map(toAdminFlight),
      nextCursor: rows.length > ADMIN_LIST_PAGE_SIZE && last !== undefined ? last.flight.id : null
    };
  },

  /** PATCH /api/admin/flights/:id (DRAFT only, else 409 FLIGHT_NOT_EDITABLE). */
  async patchFlight(id: number, patch: FlightPatchInput): Promise<AdminFlightDto> {
    try {
      return await withTransaction(async (tx) => {
        // Row lock: a concurrent publish/cancel/delete of the same flight waits for this transaction.
        const existing = await flightsRepository.findByIdForUpdate(tx, id);
        if (existing === undefined) throw new AppError('FLIGHT_NOT_FOUND');
        if (existing.status !== 'DRAFT') throw new AppError('FLIGHT_NOT_EDITABLE');

        const merged: FlightFields = {
          flightNumber: patch.flightNumber ?? existing.flightNumber,
          aircraftId: patch.aircraftId ?? existing.aircraftId,
          from: patch.from ?? existing.sourceAirport,
          to: patch.to ?? existing.destinationAirport,
          departureTime: patch.departureTime ?? existing.departureTime,
          arrivalTime: patch.arrivalTime ?? existing.arrivalTime,
          basePrice: patch.basePrice ?? existing.basePrice
        };
        await assertValidFlight(tx, merged);
        await flightsRepository.update(tx, id, {
          flightNumber: merged.flightNumber,
          aircraftId: merged.aircraftId,
          sourceAirport: merged.from,
          destinationAirport: merged.to,
          departureTime: merged.departureTime,
          arrivalTime: merged.arrivalTime,
          basePrice: merged.basePrice
        });
        return await loadAdminFlight(tx, id);
      });
    } catch (error) {
      return rethrowDuplicateFlight(error);
    }
  },

  /** DELETE /api/admin/flights/:id (DRAFT only). */
  async deleteFlight(id: number): Promise<void> {
    await withTransaction(async (tx) => {
      const existing = await flightsRepository.findByIdForUpdate(tx, id);
      if (existing === undefined) throw new AppError('FLIGHT_NOT_FOUND');
      if (existing.status !== 'DRAFT') throw new AppError('FLIGHT_NOT_EDITABLE');
      await flightsRepository.delete(tx, id);
    });
  },

  /**
   * POST /api/admin/flights/:id/publish (Section 13.3), all in ONE transaction:
   *   lock the flight row -> require DRAFT and a future departure -> price every seat of the aircraft
   *   -> bulk-insert `flight_seats` (booking module, in this same transaction) -> mark SCHEDULED.
   * Any failure rolls everything back: the flight stays DRAFT and no inventory exists, so a flight is
   * never searchable without inventory (invariant 11).
   */
  async publishFlight(id: number, now: Date = new Date()): Promise<AdminFlightDto> {
    const dto = await withTransaction(async (tx) => {
      const flight = await flightsRepository.findByIdForUpdate(tx, id);
      if (flight === undefined) throw new AppError('FLIGHT_NOT_FOUND');
      if (flight.status !== 'DRAFT') throw new AppError('FLIGHT_NOT_EDITABLE');
      if (flight.departureTime.getTime() <= now.getTime()) {
        throw new AppError('FLIGHT_NOT_EDITABLE', { message: 'A flight that has already departed cannot be published.' });
      }

      const aircraftSeats = await aircraftRepository.listSeats(tx, flight.aircraftId);
      if (aircraftSeats.length === 0) throw new Error(`aircraft ${flight.aircraftId} has no seats`);

      await inventoryService.createInventory(
        tx,
        id,
        aircraftSeats.map((seat) => ({
          seatId: seat.id,
          seatNumber: seat.seatNumber,
          rowNo: seat.rowNo,
          columnCode: seat.columnCode,
          cabinClass: seat.cabinClass,
          seatType: seat.seatType,
          price: computeSeatPrice(flight.basePrice, seat.cabinClass, seat.seatType)
        }))
      );
      await runTestHook('afterInventoryInsert');
      await flightsRepository.setStatus(tx, id, 'SCHEDULED');
      return loadAdminFlight(tx, id);
    });
    log.info({ event: 'FLIGHT_PUBLISHED', flightId: id }, 'FLIGHT_PUBLISHED');
    return dto;
  },

  /**
   * POST /api/admin/flights/:id/cancel: SCHEDULED -> CANCELLED. Existing bookings are untouched.
   * Holds are not swept: `getBookability` reads the DB, so the next hold/booking attempt is
   * refused immediately (scenario "flight cancelled while users hold seats").
   */
  async cancelFlight(id: number): Promise<AdminFlightDto> {
    const dto = await withTransaction(async (tx) => {
      const existing = await flightsRepository.findByIdForUpdate(tx, id);
      if (existing === undefined) throw new AppError('FLIGHT_NOT_FOUND');
      if (existing.status !== 'SCHEDULED') {
        throw new AppError('FLIGHT_NOT_EDITABLE', { message: 'Only scheduled flights can be cancelled.' });
      }
      await flightsRepository.setStatus(tx, id, 'CANCELLED');
      return loadAdminFlight(tx, id);
    });
    log.info({ event: 'FLIGHT_CANCELLED', flightId: id }, 'FLIGHT_CANCELLED');
    return dto;
  }
};
