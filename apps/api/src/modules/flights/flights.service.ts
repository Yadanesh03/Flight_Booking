import {
  BOOKING_CUTOFF_MINUTES,
  SEARCH_MAX_DAYS_AHEAD,
  type FlightDetailDto,
  type FlightSearchQuery,
  type FlightSummaryDto
} from '@flight/shared';
import { db } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import { addDays, dateInZone, zonedDayRangeUtc } from '../../platform/time.js';
import { validationError } from '../../platform/validation.js';
import { parseLayout } from './layout.js';
import { airportsRepository, flightsRepository, type FlightDetailRows, type FlightWithAircraft } from './flights.repository.js';
import { toAirportDto } from './catalog.service.js';

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
    const found = await airportsRepository.findByCodes(db, [query.from, query.to]);
    const origin = found.find((airport) => airport.code === query.from);
    if (origin === undefined) throw validationError('from', 'Unknown airport.');
    if (!found.some((airport) => airport.code === query.to)) throw validationError('to', 'Unknown airport.');

    const today = dateInZone(origin.timezone, now);
    if (query.date < today) throw validationError('date', 'The date cannot be in the past.');
    if (query.date > addDays(today, SEARCH_MAX_DAYS_AHEAD)) {
      throw validationError('date', `The date must be within ${SEARCH_MAX_DAYS_AHEAD} days from today.`);
    }

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
  },

  /** GET /api/flights/:id. DRAFT flights do not exist for non-admins. */
  async getFlight(flightId: number, isAdmin: boolean): Promise<FlightDetailDto> {
    const rows = await flightsRepository.getDetail(db, flightId);
    if (rows === undefined || (rows.flight.status === 'DRAFT' && !isAdmin)) throw new AppError('FLIGHT_NOT_FOUND');
    return toFlightDetail(rows);
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
