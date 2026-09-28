import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  datetime,
  decimal,
  foreignKey,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  smallint,
  tinyint,
  uniqueIndex,
  varchar
} from 'drizzle-orm/mysql-core';

/**
 * `booking` module tables (Architecture spec 8.3).
 *
 * DECISION: the spec's cross-module foreign keys (flight_seats -> flights/seats, bookings ->
 * users/flights) cannot be declared here without importing other modules' schema files, which the
 * module-boundary lint rule forbids. They are added in the hand-written migration
 * `0003_cross_module_fks.sql` instead, so the resulting database is exactly the spec's DDL.
 */

export const flightSeats = mysqlTable(
  'flight_seats',
  {
    /** This is "seatId" in every booking API. */
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    flightId: bigint('flight_id', { mode: 'number', unsigned: true }).notNull(),
    /** seats.id (cross-module FK added by migration 0003). */
    seatId: bigint('seat_id', { mode: 'number', unsigned: true }).notNull(),
    /** Denormalised so the seat map is a single-table read. */
    seatNumber: varchar('seat_number', { length: 4 }).notNull(),
    rowNo: smallint('row_no', { unsigned: true }).notNull(),
    columnCode: char('column_code', { length: 1 }).notNull(),
    cabinClass: mysqlEnum('cabin_class', ['ECONOMY', 'BUSINESS']).notNull(),
    seatType: mysqlEnum('seat_type', ['WINDOW', 'MIDDLE', 'AISLE']).notNull(),
    price: decimal('price', { precision: 10, scale: 2 }).notNull(),
    status: mysqlEnum('status', ['AVAILABLE', 'BOOKED']).notNull().default('AVAILABLE'),
    bookingId: bigint('booking_id', { mode: 'number', unsigned: true }),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`)
  },
  (table) => [
    uniqueIndex('uq_flight_seat').on(table.flightId, table.seatId),
    uniqueIndex('uq_flight_seat_number').on(table.flightId, table.seatNumber),
    index('idx_flight_status').on(table.flightId, table.status)
  ]
);

export const bookings = mysqlTable(
  'bookings',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    /** Public reference, e.g. K7XQ2M. */
    bookingRef: char('booking_ref', { length: 6 }).notNull(),
    userId: bigint('user_id', { mode: 'number', unsigned: true }).notNull(),
    flightId: bigint('flight_id', { mode: 'number', unsigned: true }).notNull(),
    status: mysqlEnum('status', ['PENDING', 'CONFIRMED', 'FAILED']).notNull(),
    /** Error code (Section 17) when FAILED. */
    failureReason: varchar('failure_reason', { length: 40 }),
    totalAmount: decimal('total_amount', { precision: 12, scale: 2 }).notNull().default('0'),
    currency: char('currency', { length: 3 }).notNull().default('INR'),
    /** UUID from the client. */
    idempotencyKey: char('idempotency_key', { length: 36 }).notNull(),
    /** SHA-256 hex of the canonical request body. */
    requestHash: char('request_hash', { length: 64 }).notNull(),
    paymentMethod: mysqlEnum('payment_method', ['UPI', 'CARD', 'NETBANKING']).notNull(),
    paymentRef: varchar('payment_ref', { length: 40 }),
    /** Flight number, route and times at booking time. */
    flightSnapshot: json('flight_snapshot'),
    confirmedAt: datetime('confirmed_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`)
  },
  (table) => [
    uniqueIndex('uq_booking_ref').on(table.bookingRef),
    uniqueIndex('uq_user_idempotency').on(table.userId, table.idempotencyKey),
    index('idx_user_created').on(table.userId, table.createdAt),
    index('idx_flight').on(table.flightId)
  ]
);

export const bookingSeats = mysqlTable(
  'booking_seats',
  {
    bookingId: bigint('booking_id', { mode: 'number', unsigned: true }).notNull(),
    flightSeatId: bigint('flight_seat_id', { mode: 'number', unsigned: true }).notNull(),
    seatNumber: varchar('seat_number', { length: 4 }).notNull(),
    price: decimal('price', { precision: 10, scale: 2 }).notNull(),
    passengerName: varchar('passenger_name', { length: 100 }).notNull(),
    passengerAge: tinyint('passenger_age', { unsigned: true }).notNull()
  },
  (table) => [
    primaryKey({ columns: [table.bookingId, table.flightSeatId] }),
    // Hard DB-level guard: one booking per flight seat (second guarantee on top of row locking).
    uniqueIndex('uq_booked_seat').on(table.flightSeatId),
    foreignKey({ name: 'fk_bs_booking', columns: [table.bookingId], foreignColumns: [bookings.id] }),
    foreignKey({ name: 'fk_bs_seat', columns: [table.flightSeatId], foreignColumns: [flightSeats.id] })
  ]
);

export type FlightSeatRow = typeof flightSeats.$inferSelect;
export type NewFlightSeatRow = typeof flightSeats.$inferInsert;
export type BookingRow = typeof bookings.$inferSelect;
export type NewBookingRow = typeof bookings.$inferInsert;
export type BookingSeatRow = typeof bookingSeats.$inferSelect;
export type NewBookingSeatRow = typeof bookingSeats.$inferInsert;
