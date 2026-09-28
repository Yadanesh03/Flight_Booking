import {
  BOOKING_CUTOFF_MINUTES,
  CACHE_TTL_SECONDS,
  SEARCH_MAX_DAYS_AHEAD,
  type FlightDetailDto,
  type FlightSearchQuery,
  type FlightSummaryDto
} from '@flight/shared';
import { getOrFill } from '../../platform/cache/getOrFill.js';
import { db } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import { addDays, dateInZone, zonedDayRangeUtc } from '../../platform/time.js';
import { validationError } from '../../platform/validation.js';
import { parseLayout } from './layout.js';
import { catalogService, toAirportDto } from './catalog.service.js';
import { flightKey, readSearchVersion, searchKey } from './flightCache.js';
import { flightsRepository, type FlightDetailRows, type FlightWithAircraft } from './flights.repository.js';

const MINUTE_MS = 60_000;

/** Whole minutes between two instants. */
function durationMinutes(departure: Date, arrival: Date): number {
  return Math.round((arrival.getTime() - departure.getTime()) / MINUTE_MS);
}

export function toFlightSummary({ flight, aircraft }: FlightWithAircraft): FlightSummaryDto {
  return {
    flightId: flight.id,
    flightNumber: flight.flightNumber,
    from: flight.sourceAirport,
    to: flight.destinationAirport,
    departureTime: flight.departureTime.toISOString(),
    arrivalTime: flight.arrivalTime.toISOString(),
    durationMinutes: durationMinutes(flight.departureTime, flight.arrivalTime),
    aircraftModel: aircraft.model,
    fromPrice: flight.basePrice
  };
}

export function toFlightDetail(rows: FlightDetailRows): FlightDetailDto {
  const { flight, aircraft, fromAirport, toAirport } = rows;
  return {
    ...toFlightSummary({ flight, aircraft }),
    status: flight.status,
    basePrice: flight.basePrice,
    currency: 'INR',
    fromAirport: toAirportDto(fromAirport),
    toAirport: toAirportDto(toAirport),
    aircraft: {
      model: aircraft.model,
      layoutColumns: aircraft.layoutColumns,
      totalRows: aircraft.totalRows,
      businessRows: aircraft.businessRows,
      seatCount: aircraft.seatCount
    }
  };
}

export type BookabilityReason = 'NOT_FOUND' | 'NOT_SCHEDULED' | 'CUTOFF';

export interface FlightSnapshot {
  flightNumber: string;
  from: string;
  to: string;
  departureTime: string;
  arrivalTime: string;
  status: 'DRAFT' | 'SCHEDULED' | 'CANCELLED';
}

export interface Bookability {
  bookable: boolean;
  reason: BookabilityReason | null;
  /** Null only when the flight does not exist. */
  snapshot: FlightSnapshot | null;
}

export interface FlightLayout {
  /** e.g. 'ABC-DEF'. */
  layoutColumns: string;
  /** e.g. ['A','B','C',null,'D','E','F']; null is an aisle. */
  columns: Array<string | null>;
  totalRows: number;
}

/** Public reads and the cross-module service API (Section 13.1, 13.4). */
export const flightsService = {
  /**
   * GET /api/flights (Section 13.1). The date is a calendar day in the SOURCE airport's timezone,
   * converted to a UTC [start, end) range. Only SCHEDULED flights that have not passed the booking
   * cutoff are returned.
   */
  async search(query: FlightSearchQuery, now: Date = new Date()): Promise<FlightSummaryDto[]> {
    const airports = await catalogService.listAirports(); // cached
    const origin = airports.find((airport) => airport.code === query.from);
    if (origin === undefined) throw validationError('from', 'Unknown airport.');
    if (!airports.some((airport) => airport.code === query.to)) throw validationError('to', 'Unknown airport.');

    const today = dateInZone(origin.timezone, now);
    if (query.date < today) throw validationError('date', 'The date cannot be in the past.');
    if (query.date > addDays(today, SEARCH_MAX_DAYS_AHEAD)) {
      throw validationError('date', `The date must be within ${SEARCH_MAX_DAYS_AHEAD} days from today.`);
    }

    const load = async (): Promise<FlightSummaryDto[]> => {
      const { start, end } = zonedDayRangeUtc(query.date, origin.timezone);
      const rows = await flightsRepository.search(db, {
        from: query.from,
        to: query.to,
        rangeStart: start,
        rangeEnd: end,
        departAfter: new Date(now.getTime() + BOOKING_CUTOFF_MINUTES * MINUTE_MS),
        sort: query.sort
      });
      return rows.map(toFlightSummary);
    };

    // `fs:search:v<ver>:...` for 60 s. Admin flight writes bump `ver`, which orphans every cached
    // search at once. Without a readable version (redis-coord down) the cache is bypassed.
    const version = await readSearchVersion();
    if (version === undefined) return load();
    const key = searchKey(version, query.from, query.to, query.date, query.sort);
    return (await getOrFill(key, CACHE_TTL_SECONDS.searchResults, load)) ?? [];
  },

  /** GET /api/flights/:id. DRAFT flights do not exist for non-admins. */
  async getFlight(flightId: number, isAdmin: boolean): Promise<FlightDetailDto> {
    // `fs:flight:<id>` for 10 min, negative-cached (30 s) when missing; deleted on every admin write.
    // The DRAFT check happens AFTER the cache so one cached copy serves admins and the public alike.
    const flight = await getOrFill(flightKey(flightId), CACHE_TTL_SECONDS.flightDetails, async () => {
      const rows = await flightsRepository.getDetail(db, flightId);
      return rows === undefined ? null : toFlightDetail(rows);
    });
    if (flight === null || (flight.status === 'DRAFT' && !isAdmin)) throw new AppError('FLIGHT_NOT_FOUND');
    return flight;
  },

  /**
   * Cross-module API for `booking` (Section 3.3, 13.4). Reads the flight by primary key with NO
   * cache, so a cancellation or cutoff takes effect on the very next hold/booking attempt.
   * bookable = SCHEDULED and departure - now > BOOKING_CUTOFF_MINUTES.
   */
  async getBookability(flightId: number, now: Date = new Date()): Promise<Bookability> {
    const flight = await flightsRepository.findById(db, flightId);
    if (flight === undefined) return { bookable: false, reason: 'NOT_FOUND', snapshot: null };
    const snapshot: FlightSnapshot = {
      flightNumber: flight.flightNumber,
      from: flight.sourceAirport,
      to: flight.destinationAirport,
      departureTime: flight.departureTime.toISOString(),
      arrivalTime: flight.arrivalTime.toISOString(),
      status: flight.status
    };
    if (flight.status !== 'SCHEDULED') return { bookable: false, reason: 'NOT_SCHEDULED', snapshot };
    if (flight.departureTime.getTime() - now.getTime() <= BOOKING_CUTOFF_MINUTES * MINUTE_MS) {
      return { bookable: false, reason: 'CUTOFF', snapshot };
    }
    return { bookable: true, reason: null, snapshot };
  },

  /** Cross-module API for `booking`: the seat-map layout of a flight's aircraft (null if no such flight). */
  async getLayout(flightId: number): Promise<FlightLayout | null> {
    const rows = await flightsRepository.findWithAircraft(db, flightId);
    if (rows === undefined) return null;
    const { layoutColumns, totalRows } = rows.aircraft;
    return { layoutColumns, columns: parseLayout(layoutColumns).columns, totalRows };
  }
};
