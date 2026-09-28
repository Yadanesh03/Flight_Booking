import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOOKING_REF_ALPHABET, PAYMENT_SIM_LATENCY_MAX_MS, PAYMENT_SIM_LATENCY_MIN_MS, type BookingRequest } from '@flight/shared';
import { generateBookingRef } from './bookingRef.js';
import { simulatePayment } from './payment.simulator.js';
import { canonicalJson, requestHash } from './requestHash.js';

describe('generateBookingRef', () => {
  it('is 6 characters from the unambiguous alphabet (no 0, O, 1 or I)', () => {
    expect(BOOKING_REF_ALPHABET).toHaveLength(32);
    for (const ambiguous of ['0', 'O', '1', 'I']) expect(BOOKING_REF_ALPHABET).not.toContain(ambiguous);
    for (let i = 0; i < 2000; i += 1) expect(generateBookingRef()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  });

  it('is not constant and rarely collides', () => {
    const refs = new Set(Array.from({ length: 2000 }, generateBookingRef));
    expect(refs.size).toBeGreaterThan(1990);
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every level and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('drops undefined values and keeps arrays ordered', () => {
    expect(canonicalJson({ a: undefined, b: [2, 1] })).toBe('{"b":[2,1]}');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson(null)).toBe('null');
  });
});

const base = (): BookingRequest => ({
  flightId: 101,
  seats: [
    { seatId: 5012, passenger: { fullName: 'Asha Rao', age: 34 } },
    { seatId: 5013, passenger: { fullName: 'Ravi Rao', age: 36 } }
  ],
  payment: { method: 'UPI', simulateOutcome: 'SUCCESS' }
});

describe('requestHash', () => {
  it('is a 64-character SHA-256 hex digest', () => {
    expect(requestHash(base())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on seat order or object key order', () => {
    const reordered: BookingRequest = {
      payment: { simulateOutcome: 'SUCCESS', method: 'UPI' },
      seats: [
        { passenger: { age: 36, fullName: 'Ravi Rao' }, seatId: 5013 },
        { passenger: { age: 34, fullName: 'Asha Rao' }, seatId: 5012 }
      ],
      flightId: 101
    };
    expect(requestHash(reordered)).toBe(requestHash(base()));
  });

  it('changes when anything meaningful changes', () => {
    const hash = requestHash(base());
    const variants: BookingRequest[] = [
      { ...base(), flightId: 102 },
      { ...base(), payment: { method: 'CARD', simulateOutcome: 'SUCCESS' } },
      { ...base(), payment: { method: 'UPI', simulateOutcome: 'DECLINED' } },
      { ...base(), seats: [base().seats[0]] },
      { ...base(), seats: [base().seats[0], { seatId: 5014, passenger: base().seats[1].passenger }] },
      { ...base(), seats: [base().seats[0], { seatId: 5013, passenger: { fullName: 'Ravi Rao', age: 37 } }] },
      { ...base(), seats: [base().seats[0], { seatId: 5013, passenger: { fullName: 'Ravi Roy', age: 36 } }] }
    ];
    for (const variant of variants) expect(requestHash(variant)).not.toBe(hash);
  });

  it('is not fooled by values that would collide under naive concatenation', () => {
    const a: BookingRequest = { ...base(), seats: [{ seatId: 1, passenger: { fullName: 'A1', age: 2 } }] };
    const b: BookingRequest = { ...base(), seats: [{ seatId: 1, passenger: { fullName: 'A', age: 12 } }] };
    expect(requestHash(a)).not.toBe(requestHash(b));
  });
});

describe('simulatePayment', () => {
  afterEach(() => vi.useRealTimers());

  it('waits 300-800 ms, then approves by default with a SIMPAY reference', async () => {
    vi.useFakeTimers();
    const started = vi.getMockedSystemTime()?.getTime() ?? Date.now();
    let settled = false;
    const promise = simulatePayment('SUCCESS').then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(PAYMENT_SIM_LATENCY_MIN_MS - 1);
    expect(settled).toBe(false); // never faster than the minimum latency
    await vi.advanceTimersByTimeAsync(PAYMENT_SIM_LATENCY_MAX_MS - PAYMENT_SIM_LATENCY_MIN_MS + 2);
    const result = await promise;
    expect(settled).toBe(true);
    expect(result.approved).toBe(true);
    expect(result.reference).toMatch(/^SIMPAY-[A-Z0-9]{8}$/);
    expect(Date.now() - started).toBeLessThanOrEqual(PAYMENT_SIM_LATENCY_MAX_MS + 2);
  });

  it('declines when asked to, and references differ between calls', async () => {
    vi.useFakeTimers();
    const first = simulatePayment('DECLINED');
    const second = simulatePayment('SUCCESS');
    await vi.advanceTimersByTimeAsync(PAYMENT_SIM_LATENCY_MAX_MS + 1);
    const [declined, approved] = await Promise.all([first, second]);
    expect(declined.approved).toBe(false);
    expect(approved.approved).toBe(true);
    expect(declined.reference).not.toBe(approved.reference);
  });
});
