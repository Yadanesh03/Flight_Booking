import { describe, expect, it } from 'vitest';
import { fromMinorUnits, sumMoney, toMinorUnits } from './money.js';

describe('money', () => {
  it('converts decimal strings to integer minor units exactly', () => {
    expect(toMinorUnits('5499.00')).toBe(549900);
    expect(toMinorUnits('5499')).toBe(549900);
    expect(toMinorUnits('5499.5')).toBe(549950);
    expect(toMinorUnits('0.07')).toBe(7);
    expect(toMinorUnits('0.10')).toBe(10);
    // A float would give 1.1 + 2.2 = 3.3000000000000003; minor units stay exact.
    expect(toMinorUnits('1.10') + toMinorUnits('2.20')).toBe(330);
  });

  it('formats minor units with exactly two decimals', () => {
    expect(fromMinorUnits(549900)).toBe('5499.00');
    expect(fromMinorUnits(7)).toBe('0.07');
    expect(fromMinorUnits(0)).toBe('0.00');
    expect(fromMinorUnits(1999999)).toBe('19999.99');
  });

  it('round-trips', () => {
    for (const amount of ['0.01', '1.00', '12.34', '99999.99', '3000.00']) {
      expect(fromMinorUnits(toMinorUnits(amount))).toBe(amount);
    }
  });

  it('rejects malformed input', () => {
    for (const bad of ['', '-1', '1.234', 'abc', '1e3', '1,000.00', ' 1.00']) {
      expect(() => toMinorUnits(bad), bad).toThrow();
    }
    expect(() => fromMinorUnits(-1)).toThrow();
    expect(() => fromMinorUnits(1.5)).toThrow();
  });

  it('sums without float error', () => {
    expect(sumMoney(['5849.00', '5599.00'])).toBe('11448.00');
    expect(sumMoney(['0.10', '0.20'])).toBe('0.30');
    expect(sumMoney([])).toBe('0.00');
  });
});
