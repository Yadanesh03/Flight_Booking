import type { AircraftCreateInput, AircraftDto, AirportDto } from '@flight/shared';
import { db, withTransaction } from '../../platform/db.js';
import { isDuplicateKey } from '../../platform/errors.js';
import { validationError } from '../../platform/validation.js';
import { generateSeats } from './layout.js';
import { aircraftRepository, airportsRepository } from './flights.repository.js';
import type { AircraftRow, AirportRow } from './schema.js';

export function toAirportDto(row: AirportRow): AirportDto {
  return { code: row.code, name: row.name, city: row.city, country: row.country, timezone: row.timezone };
}

export function toAircraftDto(row: AircraftRow): AircraftDto {
  return {
    id: row.id,
    aircraftCode: row.aircraftCode,
    model: row.model,
    layoutColumns: row.layoutColumns,
    totalRows: row.totalRows,
    businessRows: row.businessRows,
    seatCount: row.seatCount,
    createdAt: row.createdAt.toISOString()
  };
}

/** Airports and aircraft: reference data and its admin management. */
export const catalogService = {
  async listAirports(): Promise<AirportDto[]> {
    return (await airportsRepository.listAll(db)).map(toAirportDto);
  },

  /** Insert-if-missing reference data. Airports have no admin API; the seed script loads them. */
  async ensureAirports(list: AirportDto[]): Promise<void> {
    await airportsRepository.insertIgnore(db, list);
  },

  /**
   * POST /api/admin/aircraft: the aircraft and its generated seats are created in one transaction.
   * `seat_count` is computed from the generated seats, never taken from input.
   */
  async createAircraft(input: AircraftCreateInput): Promise<AircraftDto> {
    const generated = generateSeats(input.layoutColumns, input.totalRows, input.businessRows);
    try {
      return await withTransaction(async (tx) => {
        const id = await aircraftRepository.insert(tx, {
          aircraftCode: input.aircraftCode,
          model: input.model,
          layoutColumns: input.layoutColumns,
          totalRows: input.totalRows,
          businessRows: input.businessRows,
          seatCount: generated.length
        });
        await aircraftRepository.insertSeats(
          tx,
          generated.map((seat) => ({ aircraftId: id, ...seat }))
        );
        const row = await aircraftRepository.findById(tx, id);
        if (row === undefined) throw new Error('aircraft vanished after insert');
        return toAircraftDto(row);
      });
    } catch (error) {
      // DECISION: the error table (Section 17) has no "conflict" code for admin catalog data, so a
      // duplicate registration is reported as a 400 VALIDATION_ERROR on the offending field.
      if (isDuplicateKey(error, 'uq_aircraft_code')) throw validationError('aircraftCode', 'An aircraft with this code already exists.');
      throw error;
    }
  },

  async listAircraft(): Promise<AircraftDto[]> {
    return (await aircraftRepository.list(db)).map(toAircraftDto);
  }
};
