/** Error codes and their HTTP statuses (Architecture spec, Section 17). Shared with the web app. */

export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  PAYMENT_DECLINED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  FLIGHT_NOT_FOUND: 404,
  BOOKING_NOT_FOUND: 404,
  EMAIL_TAKEN: 409,
  SEAT_UNAVAILABLE: 409,
  SEAT_TEMPORARILY_UNAVAILABLE: 409,
  HOLD_EXPIRED: 409,
  FLIGHT_NOT_BOOKABLE: 409,
  FLIGHT_NOT_EDITABLE: 409,
  BOOKING_IN_PROGRESS: 409,
  BOOKING_ABANDONED: 409,
  HOLD_LIMIT_EXCEEDED: 422,
  IDEMPOTENCY_KEY_REUSED: 422,
  RATE_LIMITED: 429,
  HOLD_QUOTA_EXCEEDED: 429,
  ACCOUNT_TEMPORARILY_LOCKED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
  SERVICE_DEGRADED: 503
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export const ERROR_CODES = Object.keys(ERROR_STATUS) as ErrorCode[];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ERROR_STATUS, value);
}

/** Default human-readable messages. Never include internals or stack traces. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'The request is invalid.',
  IDEMPOTENCY_KEY_REQUIRED: 'The Idempotency-Key header is required.',
  UNAUTHENTICATED: 'Please log in to continue.',
  INVALID_CREDENTIALS: 'Invalid email or password.',
  PAYMENT_DECLINED: 'Your payment was declined. Your seats are still held; please try again.',
  FORBIDDEN: 'You do not have permission to do that.',
  NOT_FOUND: 'Not found.',
  FLIGHT_NOT_FOUND: 'Flight not found.',
  BOOKING_NOT_FOUND: 'Booking not found.',
  EMAIL_TAKEN: 'An account with this email already exists.',
  SEAT_UNAVAILABLE: 'Some seats have already been booked.',
  SEAT_TEMPORARILY_UNAVAILABLE: 'Some seats are being held by another traveller.',
  HOLD_EXPIRED: 'Your seat hold has expired. Please select seats again.',
  FLIGHT_NOT_BOOKABLE: 'This flight is no longer available for booking.',
  FLIGHT_NOT_EDITABLE: 'Only draft flights can be changed.',
  BOOKING_IN_PROGRESS: 'This booking is already being processed.',
  BOOKING_ABANDONED: 'This booking attempt timed out. Please try again.',
  HOLD_LIMIT_EXCEEDED: 'You have reached the seat hold limit.',
  IDEMPOTENCY_KEY_REUSED: 'This Idempotency-Key was already used with a different request.',
  RATE_LIMITED: 'Too many requests. Please slow down.',
  HOLD_QUOTA_EXCEEDED: 'You have reached the hourly seat hold limit.',
  ACCOUNT_TEMPORARILY_LOCKED: 'Too many failed login attempts. Please try again later.',
  INTERNAL_ERROR: 'Something went wrong. Please try again.',
  SERVICE_UNAVAILABLE: 'Service temporarily unavailable.',
  SERVICE_DEGRADED: 'Service temporarily unavailable.'
};

/** Error shape returned by every failed API call. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
  requestId?: string;
}

/**
 * Booking failure reasons persisted in `bookings.failure_reason` (an ErrorCode) so a replay can
 * return the same status/code as originally returned.
 */
export const BOOKING_FAILURE_REASONS = [
  'HOLD_EXPIRED',
  'SERVICE_DEGRADED',
  'FLIGHT_NOT_BOOKABLE',
  'VALIDATION_ERROR',
  'PAYMENT_DECLINED',
  'SEAT_UNAVAILABLE',
  'BOOKING_ABANDONED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR'
] as const satisfies readonly ErrorCode[];

export type BookingFailureReason = (typeof BOOKING_FAILURE_REASONS)[number];

export function isBookingFailureReason(value: unknown): value is BookingFailureReason {
  return typeof value === 'string' && (BOOKING_FAILURE_REASONS as readonly string[]).includes(value);
}
