import { z } from 'zod';
import { AIRCRAFT_MAX_BUSINESS_ROWS, AIRCRAFT_MAX_ROWS } from '../constants.js';

export const FLIGHT_STATUSES = ['DRAFT', 'SCHEDULED', 'CANCELLED'] as const;
export type FlightStatus = (typeof FLIGHT_STATUSES)[number];

export const iataSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Must be a 3-letter IATA airport code.');

function isRealIsoDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** `YYYY-MM-DD`, a real calendar date. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date in YYYY-MM-DD format.')
  .refine(isRealIsoDate, { message: 'Not a valid calendar date.' });

export const SEARCH_SORTS = ['departure', 'price'] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

export const flightSearchQuerySchema = z
  .object({
    from: iataSchema,
    to: iataSchema,
    date: isoDateSchema,
    sort: z.enum(SEARCH_SORTS).default('departure')
  })
  .refine((value) => value.from !== value.to, {
    message: 'Origin and destination must differ.',
    path: ['to']
  });
export type FlightSearchQuery = z.infer<typeof flightSearchQuerySchema>;

// --- Admin: aircraft --------------------------------------------------------

/** e.g. 'ABC-DEF' (single aisle) or 'AC-DF'. A dash marks an aisle; letters must be unique. */
export const layoutColumnsSchema = z
  .string()
  .trim()
  .toUpperCase()
  .max(20)
  .regex(/^[A-Z]+(-[A-Z]+)*$/, 'Use letters with a dash for aisles, e.g. ABC-DEF.')
  .refine(
    (value) => {
      const letters = value.replaceAll('-', '');
      return new Set(letters).size === letters.length;
    },
    { message: 'Column letters must be unique.' }
  );

export const aircraftCreateSchema = z
  .object({
    aircraftCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{2,20}$/, 'Use 2-20 letters, digits or dashes.'),
    model: z.string().trim().min(1).max(40),
    layoutColumns: layoutColumnsSchema,
    totalRows: z.number().int().min(1).max(AIRCRAFT_MAX_ROWS),
    businessRows: z.number().int().min(0).max(AIRCRAFT_MAX_BUSINESS_ROWS).default(0)
  })
  .refine((value) => value.businessRows <= value.totalRows, {
    message: 'businessRows cannot exceed totalRows.',
    path: ['businessRows']
  });
export type AircraftCreateInput = z.infer<typeof aircraftCreateSchema>;

// --- Admin: flights ---------------------------------------------------------

/** Accepts a number or numeric string; normalised to a 2-decimal string (money is never a float). */
export const moneySchema = z
  .union([z.number().finite(), z.string()])
  .transform((value) => String(value).trim())
  .pipe(z.string().regex(/^\d{1,8}(\.\d{1,2})?$/, 'Must be a positive amount with up to 2 decimals.'))
  .transform((value) => Number(value).toFixed(2))
  .refine((value) => Number(value) > 0, { message: 'Must be greater than zero.' });

const dateTimeSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value))
  .refine((value) => !Number.isNaN(value.getTime()), { message: 'Invalid date-time.' });

export const flightNumberSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2}-\d{1,4}$/, 'Use an airline code and number, e.g. AI-101.');

const flightFields = z.object({
  flightNumber: flightNumberSchema,
  aircraftId: z.number().int().positive(),
  from: iataSchema,
  to: iataSchema,
  departureTime: dateTimeSchema,
  arrivalTime: dateTimeSchema,
  basePrice: moneySchema
});

export const flightCreateSchema = flightFields
  .refine((value) => value.from !== value.to, {
    message: 'Origin and destination must differ.',
    path: ['to']
  })
  .refine((value) => value.arrivalTime > value.departureTime, {
    message: 'Arrival must be after departure.',
    path: ['arrivalTime']
  });
export type FlightCreateInput = z.infer<typeof flightCreateSchema>;

/**
 * Patch: any subset of fields. Cross-field rules (route, times) are re-checked against the merged
 * flight in the service, because a patch may contain only one side of a pair.
 */
export const flightPatchSchema = flightFields.partial().refine((value) => Object.keys(value).length > 0, {
  message: 'Provide at least one field to change.'
});
export type FlightPatchInput = z.infer<typeof flightPatchSchema>;

export const adminFlightListQuerySchema = z.object({
  status: z.enum(FLIGHT_STATUSES).optional(),
  cursor: z.coerce.number().int().positive().optional()
});
export type AdminFlightListQuery = z.infer<typeof adminFlightListQuerySchema>;
