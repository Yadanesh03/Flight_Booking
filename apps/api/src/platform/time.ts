/** Timezone helpers built on Intl (no date library). All instants are UTC; zones are IANA names. */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock parts of `utcMs` in `timeZone`. */
function zonedParts(timeZone: string, utcMs: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second')
  };
}

/** Offset of `timeZone` from UTC (ms, positive east of Greenwich) at the instant `utcMs`. */
export function tzOffsetMs(timeZone: string, utcMs: number): number {
  const p = zonedParts(timeZone, utcMs);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(utcMs / 1000) * 1000;
}

/** `YYYY-MM-DD` of the instant `now` as seen in `timeZone`. */
export function dateInZone(timeZone: string, now: Date = new Date()): string {
  const p = zonedParts(timeZone, now.getTime());
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Adds calendar days to a `YYYY-MM-DD` date (pure calendar arithmetic, no timezone). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The UTC instant at which local midnight of `date` occurs in `timeZone`. */
export function zonedMidnightUtc(date: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wallAsUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
  // The offset must be evaluated at the answer, not at the wall-clock guess, so iterate once.
  const firstGuess = wallAsUtc - tzOffsetMs(timeZone, wallAsUtc);
  return new Date(wallAsUtc - tzOffsetMs(timeZone, firstGuess));
}

/** UTC `[start, end)` covering the whole local calendar day `date` in `timeZone`. */
export function zonedDayRangeUtc(date: string, timeZone: string): { start: Date; end: Date } {
  return { start: zonedMidnightUtc(date, timeZone), end: zonedMidnightUtc(addDays(date, 1), timeZone) };
}
