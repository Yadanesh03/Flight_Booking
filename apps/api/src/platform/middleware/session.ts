import type { RequestHandler } from 'express';
import { DEGRADED_LOG_THROTTLE_MS, SESSION_COOKIE_NAME, type Role } from '@flight/shared';
import { logThrottled, logger } from '../logger.js';

export interface ResolvedSession {
  userId: number;
  role: Role;
}

/**
 * Looks a session id up in the session store. Implemented by the auth module and injected by app.ts
 * (platform never imports modules). Returns null for unknown/expired sessions and throws when the
 * store is unavailable.
 */
export type SessionResolver = (sid: string) => Promise<ResolvedSession | null>;

/** 32 random bytes, base64url => exactly 43 characters. Anything else cannot be a real session id. */
const SID_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const raw = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Step 5 of the pipeline (Section 10.1): resolve the `sid` cookie to `req.user`.
 *
 * If the session store (redis-coord) fails, `req.sessionUnavailable` is set instead of throwing:
 * `public`/`optional` routes continue without a user; `session`/`admin` routes answer 503
 * SERVICE_DEGRADED (Section 10.3) in `requireAuth`.
 */
export function sessionMiddleware(resolve: SessionResolver): RequestHandler {
  return async (req, _res, next) => {
    const sid = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    if (sid === undefined || !SID_FORMAT.test(sid)) {
      next();
      return;
    }
    try {
      const session = await resolve(sid);
      if (session !== null) {
        req.user = { id: session.userId, role: session.role };
        req.log = req.log.child({ userId: session.userId });
      }
    } catch (error) {
      req.sessionUnavailable = true;
      logThrottled(logger, 'SESSION_STORE_UNAVAILABLE', DEGRADED_LOG_THROTTLE_MS, {
        module: 'platform',
        err: error instanceof Error ? error.message : String(error)
      });
    }
    next();
  };
}
