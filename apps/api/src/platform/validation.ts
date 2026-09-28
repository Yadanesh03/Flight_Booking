import { z } from 'zod';
import { AppError } from './errors.js';

const idSchema = z.coerce.number().int().positive();

/** Parses a numeric id from a path param. Anything else is a 400 VALIDATION_ERROR. */
export function parseId(value: unknown, name: string): number {
  const parsed = idSchema.safeParse(typeof value === 'string' && /^\d+$/.test(value) ? value : Number.NaN);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', { details: { issues: [{ path: name, message: 'Must be a positive integer.' }] } });
  }
  return parsed.data;
}

/** A single-field 400 for conflicts the error table has no dedicated code for (e.g. duplicate flight). */
export function validationError(path: string, message: string): AppError {
  return new AppError('VALIDATION_ERROR', { details: { issues: [{ path, message }] } });
}
