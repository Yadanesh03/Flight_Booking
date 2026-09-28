import { describe, expect, it } from 'vitest';
import { generateSeats, parseLayout, seatTypeFor } from './layout.js';
import { computeSeatPrice } from './pricing.js';

describe('seat layout generation', () => {
  it("parses 'ABC-DEF' with an aisle between C and D", () => {
    const layout = parseLayout('ABC-DEF');
    expect(layout.columns).toEqual(['A', 'B', 'C', null, 'D', 'E', 'F']);
    expect(layout.seatColumns).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });

  it('assigns WINDOW / MIDDLE / AISLE for a 3-3 layout', () => {
    const { columns } = parseLayout('ABC-DEF');
    expect(['A', 'B', 'C', 'D', 'E', 'F'].map((c) => seatTypeFor(columns, c))).toEqual([
      'WINDOW',
      'MIDDLE',
      'AISLE',
      'AISLE',
      'MIDDLE',
      'WINDOW'
    ]);
  });

  it('assigns types for the ATR 2-2 layout (no middle seats)', () => {
    const { columns } = parseLayout('AC-DF');
    expect(['A', 'C', 'D', 'F'].map((c) => seatTypeFor(columns, c))).toEqual(['WINDOW', 'AISLE', 'AISLE', 'WINDOW']);
  });

  it('handles twin-aisle layouts and lets WINDOW win over AISLE', () => {
    const twin = parseLayout('AB-CDE-FG').columns;
    expect(['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((c) => seatTypeFor(twin, c))).toEqual([
      'WINDOW',
      'AISLE',
      'AISLE',
      'MIDDLE',
      'AISLE',
      'AISLE',
      'WINDOW'
    ]);
    // 'A-B': both seats are first/last (window) *and* next to the aisle; window wins.
    const pair = parseLayout('A-B').columns;
    expect([seatTypeFor(pair, 'A'), seatTypeFor(pair, 'B')]).toEqual(['WINDOW', 'WINDOW']);
  });

  it('generates rows x columns seats with unique numbers and business rows first', () => {
    const seats = generateSeats('ABC-DEF', 30, 2);
    expect(seats).toHaveLength(180); // A320neo
    expect(new Set(seats.map((s) => s.seatNumber)).size).toBe(180);
    expect(seats[0]).toEqual({ seatNumber: '1A', rowNo: 1, columnCode: 'A', cabinClass: 'BUSINESS', seatType: 'WINDOW' });
    expect(seats.filter((s) => s.cabinClass === 'BUSINESS')).toHaveLength(12);
    expect(seats.filter((s) => s.rowNo <= 2).every((s) => s.cabinClass === 'BUSINESS')).toBe(true);
    expect(seats.filter((s) => s.rowNo > 2).every((s) => s.cabinClass === 'ECONOMY')).toBe(true);
    expect(seats.at(-1)).toMatchObject({ seatNumber: '30F', seatType: 'WINDOW' });
  });

  it('matches the seed aircraft sizes from Section 22', () => {
    expect(generateSeats('ABC-DEF', 37, 2)).toHaveLength(222); // A321neo
    expect(generateSeats('ABC-DEF', 31, 2)).toHaveLength(186); // B737-800
    expect(generateSeats('AC-DF', 18, 0)).toHaveLength(72); // ATR 72
  });

  it('keeps seat numbers within VARCHAR(4) at the maximum size', () => {
    const seats = generateSeats('ABCDEFGHIJ-KLMNOPQRS', 80, 20);
    expect(Math.max(...seats.map((s) => s.seatNumber.length))).toBeLessThanOrEqual(4);
  });
});

describe('seat pricing', () => {
  it('applies the cabin multiplier and seat-type surcharge', () => {
    expect(computeSeatPrice('5499.00', 'ECONOMY', 'MIDDLE')).toBe('5499.00');
    expect(computeSeatPrice('5499.00', 'ECONOMY', 'WINDOW')).toBe('5849.00'); // the spec's example price
    expect(computeSeatPrice('5499.00', 'ECONOMY', 'AISLE')).toBe('5749.00');
    expect(computeSeatPrice('5499.00', 'BUSINESS', 'MIDDLE')).toBe('13747.50');
    expect(computeSeatPrice('5499.00', 'BUSINESS', 'WINDOW')).toBe('14097.50');
  });

  it('rounds half up to 2 decimals in exact integer arithmetic', () => {
    // 5499.01 x 2.5 = 13747.525 -> 13747.53
    expect(computeSeatPrice('5499.01', 'BUSINESS', 'MIDDLE')).toBe('13747.53');
    // 0.03 x 2.5 = 0.075 -> 0.08
    expect(computeSeatPrice('0.03', 'BUSINESS', 'MIDDLE')).toBe('0.08');
    // 0.01 x 2.5 = 0.025 -> 0.03
    expect(computeSeatPrice('0.01', 'BUSINESS', 'MIDDLE')).toBe('0.03');
    // A float implementation would drift; check a value where 0.1+0.2-style error would show.
    expect(computeSeatPrice('3000.10', 'ECONOMY', 'AISLE')).toBe('3250.10');
  });
});
