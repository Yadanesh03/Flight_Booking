import type { RequestHandler } from 'express';
import { AppError } from '../errors.js';

/**
 * Route auth modes (Section 10.1 step 6):
 *  - `public`   : no user needed.
 *  - `optional` : user attached if present.
 *  - `session`  : 401 if absent.
 *  - `admin`    : 401 if absent, 403 if role is not ADMIN.
 */
export type AuthMode = 'public' | 'optional' | 'session' | 'admin';

export function requireAuth(mode: AuthMode): RequestHandler {
  return (req, _res, next) => {
    if (mode === 'public' || mode === 'optional') {
      next();
      return;
    }
    if (req.user === undefined) {
      // Could not check the session at all (redis-coord down) => 503, not a misleading 401.
      if (req.sessionUnavailable === true) throw new AppError('SERVICE_DEGRADED');
      throw new AppError('UNAUTHENTICATED');
    }
    if (mode === 'admin' && req.user.role !== 'ADMIN') throw new AppError('FORBIDDEN');
    next();
  };
}
