import type { RequestHandler } from 'express';
import { config } from '../config.js';
import { AppError } from '../errors.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function originOf(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * Step 3 of the pipeline (Section 10.1): CSRF defence for state-changing requests. The `Origin`
 * header (or the origin of `Referer` when `Origin` is absent) must equal ALLOWED_ORIGIN, otherwise
 * 403 FORBIDDEN. Together with `SameSite=Lax` cookies this is the CSRF protection.
 *
 * A request with neither header is rejected: browsers always send `Origin` on cross-origin and
 * same-origin unsafe requests, so a missing value means a non-browser client we cannot vouch for.
 */
export const originCheck: RequestHandler = (req, _res, next) => {
  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }
  const originHeader = req.get('origin');
  // The literal string "null" is sent by sandboxed/redirected contexts; it never matches.
  const origin = originHeader !== undefined ? originOf(originHeader) : originOf(req.get('referer'));
  if (origin === undefined || origin !== config.allowedOrigin) {
    throw new AppError('FORBIDDEN', { message: 'Cross-origin request blocked.' });
  }
  next();
};
