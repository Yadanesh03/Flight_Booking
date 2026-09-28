import { randomInt } from 'node:crypto';
import { BOOKING_REF_ALPHABET, BOOKING_REF_LENGTH } from '@flight/shared';

/** A public booking reference like K7XQ2M: 6 characters from an alphabet with no 0/O/1/I. */
export function generateBookingRef(): string {
  let ref = '';
  for (let i = 0; i < BOOKING_REF_LENGTH; i += 1) ref += BOOKING_REF_ALPHABET[randomInt(BOOKING_REF_ALPHABET.length)];
  return ref;
}
