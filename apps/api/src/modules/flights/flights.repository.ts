import { and, asc, desc, eq, gt, gte, inArray, lt } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import type { FlightStatus, SearchSort } from '@flight/shared';
import type { Executor } from '../../platform/db.js';
import { countDbQuery } from '../../platform/testSupport.js';
import {
  aircraft,
  airports,
  flights,
  seats,
  type AircraftRow,
  type AirportRow,
  type FlightRow,
  type NewFlightRow,
  type NewSeatRow
} from './schema.js';

/** Data access only; business rules live in the services. */

export interface FlightWithAircraft {
  flight: FlightRow;
  aircraft: AircraftRow;
}

export interface FlightDetailRows extends FlightWithAircraft {
  fromAirport: AirportRow;
  toAirport: AirportRow;
}

export const airportsRepository = {
  listAll(executor: Executor): Promise<AirportRow[]> {
    return executor.select().from(airports).orderBy(asc(airports.code));
  },

  findByCodes(executor: Executor, codes: string[]): Promise<AirportRow[]> {
    if (codes.length === 0) return Promise.resolve([]);
    return executor.select().from(airports).where(inArray(airports.code, codes));
  },

  /** Insert-if-missing by IATA code (seed uses this; airports are reference data with no admin API). */
  async insertIgnore(executor: Executor, rows: AirportRow[]): Promise<void> {
    if (rows.length === 0) return;
    await executor.insert(airports).ignore().values(rows);
  }
};

export const aircraftRepository = {
  async insert(executor: Executor, values: typeof aircraft.$inferInsert): Promise<number> {
    const [result] = await executor.insert(aircraft).values(values);
    return result.insertId;
  },

  /** Bulk insert in chunks so the statement stays well under max_allowed_packet. */
  async insertSeats(executor: Executor, rows: NewSeatRow[]): Promise<void> {
    const chunkSize = 500;
    for (let i = 0; i < rows.length; i += chunkSize) {
      await executor.insert(seats).values(rows.slice(i, i + chunkSize));
    }
  },

  list(executor: Executor): Promise<AircraftRow[]> {
    return executor.select().from(aircraft).orderBy(asc(aircraft.id));
  },

  async findById(executor: Executor, id: number): Promise<AircraftRow | undefined> {
    const rows = await executor.select().from(aircraft).where(eq(aircraft.id, id)).limit(1);
    return rows[0];
  },

  async findByCode(executor: Executor, aircraftCode: string): Promise<AircraftRow | undefined> {
    const rows = await executor.select().from(aircraft).where(eq(aircraft.aircraftCode, aircraftCode)).limit(1);
    return rows[0];
  },

  /** All seats of an aircraft in a stable order (row, then column). */
  listSeats(executor: Executor, aircraftId: number) {
    return executor.select().from(seats).where(eq(seats.aircraftId, aircraftId)).orderBy(asc(seats.rowNo), asc(seats.columnCode));
  }
};

export interface SearchParams {
  from: string;
  to: string;
  /** Inclusive UTC start of the local day. */
  rangeStart: Date;
  /** Exclusive UTC end of the local day. */
  rangeEnd: Date;
  /** Only flights departing strictly after this instant (now + booking cutoff). */
  departAfter: Date;
  sort: SearchSort;
}

export interface AdminListParams {
  status?: FlightStatus | undefined;
  cursor?: number | undefined;
  limit: number;
}

export const flightsRepository = {
  async insert(executor: Executor, values: NewFlightRow): Promise<number> {
    const [result] = await executor.insert(flights).values(values);
    return result.insertId;
  },

  async findById(executor: Executor, id: number): Promise<FlightRow | undefined> {
    const rows = await executor.select().from(flights).where(eq(flights.id, id)).limit(1);
    return rows[0];
  },

  /** Locks the flight row for the rest of the transaction (publish/patch/cancel serialise on this). */
  async findByIdForUpdate(executor: Executor, id: number): Promise<FlightRow | undefined> {
    const rows = await executor.select().from(flights).where(eq(flights.id, id)).limit(1).for('update');
    return rows[0];
  },

  async findWithAircraft(executor: Executor, id: number): Promise<FlightWithAircraft | undefined> {
    const rows = await executor
      .select({ flight: flights, aircraft })
      .from(flights)
      .innerJoin(aircraft, eq(flights.aircraftId, aircraft.id))
      .where(eq(flights.id, id))
      .limit(1);
    return rows[0];
  },

  /** Full detail read used by GET /api/flights/:id. Counted by the test-mode stampede tests. */
  async getDetail(executor: Executor, id: number): Promise<FlightDetailRows | undefined> {
    countDbQuery('flightById');
    const src = alias(airports, 'src_airport');
    const dst = alias(airports, 'dst_airport');
    const rows = await executor
      .select({ flight: flights, aircraft, fromAirport: src, toAirport: dst })
      .from(flights)
      .innerJoin(aircraft, eq(flights.aircraftId, aircraft.id))
      .innerJoin(src, eq(flights.sourceAirport, src.code))
      .innerJoin(dst, eq(flights.destinationAirport, dst.code))
      .where(eq(flights.id, id))
      .limit(1);
    return rows[0];
  },

  /** SCHEDULED flights on a route within a UTC range that have not passed the booking cutoff. */
  search(executor: Executor, params: SearchParams): Promise<FlightWithAircraft[]> {
    const order =
      params.sort === 'price'
        ? [asc(flights.basePrice), asc(flights.departureTime), asc(flights.id)]
        : [asc(flights.departureTime), asc(flights.id)];
    return executor
      .select({ flight: flights, aircraft })
      .from(flights)
      .innerJoin(aircraft, eq(flights.aircraftId, aircraft.id))
      .where(
        and(
          eq(flights.sourceAirport, params.from),
          eq(flights.destinationAirport, params.to),
          eq(flights.status, 'SCHEDULED'),
          gte(flights.departureTime, params.rangeStart),
          lt(flights.departureTime, params.rangeEnd),
          gt(flights.departureTime, params.departAfter)
        )
      )
      .orderBy(...order);
  },

  /** Newest first; `cursor` is the smallest id of the previous page. */
  listAdmin(executor: Executor, params: AdminListParams): Promise<FlightWithAircraft[]> {
    return executor
      .select({ flight: flights, aircraft })
      .from(flights)
      .innerJoin(aircraft, eq(flights.aircraftId, aircraft.id))
      .where(
        and(
          params.status === undefined ? undefined : eq(flights.status, params.status),
          params.cursor === undefined ? undefined : lt(flights.id, params.cursor)
        )
      )
      .orderBy(desc(flights.id))
      .limit(params.limit);
  },

  async update(executor: Executor, id: number, values: Partial<NewFlightRow>): Promise<void> {
    await executor.update(flights).set(values).where(eq(flights.id, id));
  },

  async setStatus(executor: Executor, id: number, status: FlightStatus): Promise<void> {
    await executor.update(flights).set({ status }).where(eq(flights.id, id));
  },

  async delete(executor: Executor, id: number): Promise<void> {
    await executor.delete(flights).where(eq(flights.id, id));
  }
};
