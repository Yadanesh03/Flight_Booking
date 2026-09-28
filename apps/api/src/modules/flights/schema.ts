import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  datetime,
  decimal,
  foreignKey,
  index,
  mysqlEnum,
  mysqlTable,
  smallint,
  uniqueIndex,
  varchar
} from 'drizzle-orm/mysql-core';

/**
 * `flights` module tables (Architecture spec 8.2). `row_no` is used instead of `row_number`
 * because ROW_NUMBER is reserved in MySQL 8. Money is DECIMAL; times are UTC DATETIME(3).
 * See auth/schema.ts for why `updated_at` needs a post-generation patch.
 */

export const airports = mysqlTable('airports', {
  /** IATA code, e.g. BOM. */
  code: char('code', { length: 3 }).primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  city: varchar('city', { length: 80 }).notNull(),
  country: varchar('country', { length: 80 }).notNull(),
  /** IANA zone, e.g. Asia/Kolkata. */
  timezone: varchar('timezone', { length: 40 }).notNull()
});

export const aircraft = mysqlTable(
  'aircraft',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    /** Registration-like, e.g. VT-EXA. */
    aircraftCode: varchar('aircraft_code', { length: 20 }).notNull(),
    /** e.g. A320neo. */
    model: varchar('model', { length: 40 }).notNull(),
    /** e.g. 'ABC-DEF'; '-' marks an aisle. */
    layoutColumns: varchar('layout_columns', { length: 20 }).notNull(),
    totalRows: smallint('total_rows', { unsigned: true }).notNull(),
    businessRows: smallint('business_rows', { unsigned: true }).notNull().default(0),
    seatCount: smallint('seat_count', { unsigned: true }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`)
  },
  (table) => [uniqueIndex('uq_aircraft_code').on(table.aircraftCode)]
);

export const seats = mysqlTable(
  'seats',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    aircraftId: bigint('aircraft_id', { mode: 'number', unsigned: true }).notNull(),
    /** e.g. 12A. */
    seatNumber: varchar('seat_number', { length: 4 }).notNull(),
    rowNo: smallint('row_no', { unsigned: true }).notNull(),
    columnCode: char('column_code', { length: 1 }).notNull(),
    cabinClass: mysqlEnum('cabin_class', ['ECONOMY', 'BUSINESS']).notNull(),
    seatType: mysqlEnum('seat_type', ['WINDOW', 'MIDDLE', 'AISLE']).notNull()
  },
  (table) => [
    uniqueIndex('uq_seat').on(table.aircraftId, table.seatNumber),
    foreignKey({ name: 'fk_seats_aircraft', columns: [table.aircraftId], foreignColumns: [aircraft.id] })
  ]
);

export const flights = mysqlTable(
  'flights',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    /** e.g. AI-101. */
    flightNumber: varchar('flight_number', { length: 10 }).notNull(),
    aircraftId: bigint('aircraft_id', { mode: 'number', unsigned: true }).notNull(),
    sourceAirport: char('source_airport', { length: 3 }).notNull(),
    destinationAirport: char('destination_airport', { length: 3 }).notNull(),
    /** UTC. */
    departureTime: datetime('departure_time', { mode: 'date', fsp: 3 }).notNull(),
    /** UTC. */
    arrivalTime: datetime('arrival_time', { mode: 'date', fsp: 3 }).notNull(),
    basePrice: decimal('base_price', { precision: 10, scale: 2 }).notNull(),
    status: mysqlEnum('status', ['DRAFT', 'SCHEDULED', 'CANCELLED']).notNull().default('DRAFT'),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`)
  },
  (table) => [
    uniqueIndex('uq_flight_departure').on(table.flightNumber, table.departureTime),
    index('idx_search').on(table.sourceAirport, table.destinationAirport, table.status, table.departureTime),
    foreignKey({ name: 'fk_flights_aircraft', columns: [table.aircraftId], foreignColumns: [aircraft.id] }),
    foreignKey({ name: 'fk_flights_src', columns: [table.sourceAirport], foreignColumns: [airports.code] }),
    foreignKey({ name: 'fk_flights_dst', columns: [table.destinationAirport], foreignColumns: [airports.code] }),
    check('chk_route', sql`${table.sourceAirport} <> ${table.destinationAirport}`),
    check('chk_times', sql`${table.arrivalTime} > ${table.departureTime}`),
    check('chk_price', sql`${table.basePrice} > 0`)
  ]
);

export type AirportRow = typeof airports.$inferSelect;
export type AircraftRow = typeof aircraft.$inferSelect;
export type SeatRow = typeof seats.$inferSelect;
export type NewSeatRow = typeof seats.$inferInsert;
export type FlightRow = typeof flights.$inferSelect;
export type NewFlightRow = typeof flights.$inferInsert;
