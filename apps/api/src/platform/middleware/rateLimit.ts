import type { RequestHandler } from 'express';
import { DEGRADED_LOG_THROTTLE_MS, RATE_LIMITS, type RateLimitRuleName } from '@flight/shared';
import { AppError } from '../errors.js';
import { logThrottled, logger } from '../logger.js';
import { coordRedis } from '../redis.js';

const log = logger.child({ module: 'platform' });

/**
 * Each rule has a fixed subject (Section 6.4): most are strictly IP or strictly the user id; only
 * `read` falls back to IP when there is no session. `req.ip` reflects TRUST_PROXY (Section 12.3).
 */
const SUBJECT_STRATEGY: Record<RateLimitRuleName, 'ip' | 'user' | 'userOrIp'> = {
  global: 'ip',
  auth_login: 'ip',
  auth_register: 'ip',
  read: 'userOrIp',
  holds: 'user',
  bookings: 'user',
  admin: 'user'
};

function subjectOf(rule: RateLimitRuleName, req: Parameters<RequestHandler>[0]): string {
  const strategy = SUBJECT_STRATEGY[rule];
  const ip = `ip:${req.ip ?? 'unknown'}`;
  switch (strategy) {
    case 'ip':
      return ip;
    case 'userOrIp':
      return req.user !== undefined ? `user:${req.user.id}` : ip;
    case 'user':
      // `holds`, `bookings` and `admin` sit only behind requireAuth('session'|'admin'), so req.user is
      // always set by the time this runs; requireUser would throw 401 first if it were somehow missing.
      if (req.user === undefined) throw new AppError('UNAUTHENTICATED');
      return `user:${req.user.id}`;
    default: {
      const exhaustive: never = strategy;
      throw new Error(`unhandled rate limit subject strategy: ${String(exhaustive)}`);
    }
  }
}

/**
 * Rate limiting (Section 12): sliding window counter via `rateLimit.lua`, two fixed windows per
 * subject. Allowed requests get `RateLimit-Limit`/`RateLimit-Remaining`; a block is 429 RATE_LIMITED
 * with `Retry-After` in whole seconds (min 1).
 *
 * Section 10.3: if redis-coord is unreachable the limiter fails OPEN (the request proceeds), logging
 * `RATE_LIMIT_BYPASSED` at most once per 10 s. Rate limiting is a defence, not a correctness
 * invariant, so an outage degrades safety rather than availability.
 */
export function rateLimit(rule: RateLimitRuleName): RequestHandler {
  const { limit, windowMs } = RATE_LIMITS[rule];
  return async (req, res, next) => {
    const subject = subjectOf(rule, req);
    const now = Date.now();
    const windowIndex = Math.floor(now / windowMs);
    const elapsedMs = now - windowIndex * windowMs;
    const currentKey = `rl:${rule}:${subject}:${windowIndex}`;
    const previousKey = `rl:${rule}:${subject}:${windowIndex - 1}`;

    let outcome: [number, number, number];
    try {
      outcome = await coordRedis.rateLimit(currentKey, previousKey, limit, windowMs, elapsedMs);
    } catch (error) {
      logThrottled(log, 'RATE_LIMIT_BYPASSED', DEGRADED_LOG_THROTTLE_MS, {
        rule,
        err: error instanceof Error ? error.message : String(error)
      });
      next();
      return;
    }

    const [allowed, remaining, retryAfterMs] = outcome;
    res.setHeader('RateLimit-Limit', String(limit));
    if (allowed === 1) {
      res.setHeader('RateLimit-Remaining', String(remaining));
      next();
      return;
    }
    throw new AppError('RATE_LIMITED', { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) });
  };
}
