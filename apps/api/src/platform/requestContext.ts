import type { Request } from 'express';
import type { Role } from '@flight/shared';
import { AppError } from './errors.js';

export interface AuthUser {
  id: number;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by the request-id middleware (first in the pipeline). */
      requestId: string;
      /** Set by session resolution when a valid session cookie is present. */
      user?: AuthUser;
      /** True when the session store (redis-coord) failed during resolution. */
      sessionUnavailable?: boolean;
    }
  }
}

/** The authenticated user. Only call on routes guarded by `session` or `admin` auth. */
export function requireUser(req: Request): AuthUser {
  if (req.user === undefined) throw new AppError('UNAUTHENTICATED');
  return req.user;
}
