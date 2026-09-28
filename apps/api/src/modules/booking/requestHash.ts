import { createHash } from 'node:crypto';
import type { BookingRequest } from '@flight/shared';

/** JSON with object keys sorted at every level and no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 hex of the canonical JSON of `{flightId, seats (sorted by seatId, with passenger), payment}`
 * (Section 8.3). Two requests with the same idempotency key must hash equal exactly when they mean
 * the same booking, regardless of key order or seat order in the JSON the client happened to send.
 */
export function requestHash(request: BookingRequest): string {
  const canonical = {
    flightId: request.flightId,
    seats: [...request.seats]
      .sort((a, b) => a.seatId - b.seatId)
      .map((seat) => ({ seatId: seat.seatId, passenger: { fullName: seat.passenger.fullName, age: seat.passenger.age } })),
    payment: { method: request.payment.method, simulateOutcome: request.payment.simulateOutcome }
  };
  return createHash('sha256').update(canonicalJson(canonical)).digest('hex');
}
