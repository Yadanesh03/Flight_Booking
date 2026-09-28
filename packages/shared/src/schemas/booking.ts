import { z } from 'zod';
import {
  BOOKINGS_PAGE_SIZE,
  BOOKINGS_PAGE_SIZE_MAX,
  HOLD_REQUEST_MAX_SEAT_IDS,
  MAX_SEATS_PER_FLIGHT_HOLD
} from '../constants.js';

const seatIdSchema = z.number().int().positive();

const allUnique = (values: number[]): boolean => new Set(values).size === values.length;

/**
 * 1..N unique seat ids. The per-flight limit (MAX_SEATS_PER_FLIGHT_HOLD) is enforced by the hold
 * script so that 7 seats yields 422 HOLD_LIMIT_EXCEEDED (spec test 8), not 400.
 */
export const holdsRequestSchema = z.object({
  seatIds: z
    .array(seatIdSchema)
    .min(1)
    .max(HOLD_REQUEST_MAX_SEAT_IDS)
    .refine(allUnique, { message: 'seatIds must be unique.' })
});
export type HoldsRequest = z.infer<typeof holdsRequestSchema>;

export const PAYMENT_METHODS = ['UPI', 'CARD', 'NETBANKING'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const SIMULATED_OUTCOMES = ['SUCCESS', 'DECLINED'] as const;
export type SimulatedOutcome = (typeof SIMULATED_OUTCOMES)[number];

export const passengerSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  age: z.number().int().min(0).max(120)
});

export const bookingRequestSchema = z.object({
  flightId: z.number().int().positive(),
  seats: z
    .array(z.object({ seatId: seatIdSchema, passenger: passengerSchema }))
    .min(1)
    .max(MAX_SEATS_PER_FLIGHT_HOLD)
    .refine((seats) => allUnique(seats.map((seat) => seat.seatId)), { message: 'seatIds must be unique.' }),
  payment: z.object({
    method: z.enum(PAYMENT_METHODS),
    simulateOutcome: z.enum(SIMULATED_OUTCOMES).default('SUCCESS')
  })
});
export type BookingRequest = z.infer<typeof bookingRequestSchema>;
/** The request as a client builds it (simulateOutcome optional). */
export type BookingRequestInput = z.input<typeof bookingRequestSchema>;

/** UUID v4. */
export const idempotencyKeySchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'Must be a UUID v4.');

export const BOOKING_LIST_STATUSES = ['CONFIRMED', 'FAILED', 'ALL'] as const;
export type BookingListStatus = (typeof BOOKING_LIST_STATUSES)[number];

export const bookingListQuerySchema = z.object({
  status: z.enum(BOOKING_LIST_STATUSES).default('CONFIRMED'),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(BOOKINGS_PAGE_SIZE_MAX).default(BOOKINGS_PAGE_SIZE)
});
export type BookingListQuery = z.infer<typeof bookingListQuerySchema>;

export const bookingRefSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{6}$/, 'Invalid booking reference.');
