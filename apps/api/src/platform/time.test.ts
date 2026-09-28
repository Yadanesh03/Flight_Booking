import { describe, expect, it } from 'vitest';
import { addDays, dateInZone, tzOffsetMs, zonedDayRangeUtc, zonedMidnightUtc } from './time.js';

describe('time helpers', () => {
  it('computes fixed and DST offsets', () => {
    expect(tzOffsetMs('Asia/Kolkata', Date.UTC(2026, 9, 5))).toBe(5.5 * 3_600_000);
    expect(tzOffsetMs('UTC', Date.UTC(2026, 9, 5))).toBe(0);
    // New York: EDT (-4) in July, EST (-5) in January.
    expect(tzOffsetMs('America/New_York', Date.UTC(2026, 6, 1))).toBe(-4 * 3_600_000);
    expect(tzOffsetMs('America/New_York', Date.UTC(2026, 0, 1))).toBe(-5 * 3_600_000);
  });

  it('converts local midnight in Asia/Kolkata (UTC+5:30) to UTC', () => {
    expect(zonedMidnightUtc('2026-10-05', 'Asia/Kolkata').toISOString()).toBe('2026-10-04T18:30:00.000Z');
  });

  it('builds a [start, end) UTC range for a local day', () => {
    const { start, end } = zonedDayRangeUtc('2026-10-05', 'Asia/Kolkata');
    expect(start.toISOString()).toBe('2026-10-04T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-10-05T18:30:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(24 * 3_600_000);
  });

  it('handles DST transitions (23h and 25h days) using the offset at local midnight', () => {
    // US clocks go forward on 2026-03-08 (23-hour day) and back on 2026-11-01 (25-hour day).
    const spring = zonedDayRangeUtc('2026-03-08', 'America/New_York');
    expect(spring.start.toISOString()).toBe('2026-03-08T05:00:00.000Z'); // EST
    expect(spring.end.toISOString()).toBe('2026-03-09T04:00:00.000Z'); // EDT
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * 3_600_000);

    const autumn = zonedDayRangeUtc('2026-11-01', 'America/New_York');
    expect(autumn.start.toISOString()).toBe('2026-11-01T04:00:00.000Z'); // EDT
    expect(autumn.end.toISOString()).toBe('2026-11-02T05:00:00.000Z'); // EST
    expect(autumn.end.getTime() - autumn.start.getTime()).toBe(25 * 3_600_000);
  });

  it('adjacent local days tile the timeline with no gap or overlap', () => {
    const a = zonedDayRangeUtc('2026-10-05', 'Asia/Kolkata');
    const b = zonedDayRangeUtc('2026-10-06', 'Asia/Kolkata');
    expect(a.end.getTime()).toBe(b.start.getTime());
  });

  it('reports the local calendar date of an instant', () => {
    // 20:00 UTC on Oct 5 is already Oct 6 in India (01:30 IST) but still Oct 5 in New York.
    const instant = new Date('2026-10-05T20:00:00Z');
    expect(dateInZone('Asia/Kolkata', instant)).toBe('2026-10-06');
    expect(dateInZone('America/New_York', instant)).toBe('2026-10-05');
    expect(dateInZone('UTC', instant)).toBe('2026-10-05');
  });

  it('adds calendar days across month and year boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-09-28', 90)).toBe('2026-12-27');
  });
});
