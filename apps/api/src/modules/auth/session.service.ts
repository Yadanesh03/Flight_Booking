import { createHash, randomBytes } from 'node:crypto';
import {
  SESSION_ABSOLUTE_MAX_SECONDS,
  SESSION_IDLE_TTL_SECONDS,
  SESSION_TOKEN_BYTES,
  SESSION_TOUCH_INTERVAL_SECONDS,
  type Role
} from '@flight/shared';
import { moduleLogger } from '../../platform/logger.js';
import { coordGuard, coordRedis } from '../../platform/redis.js';

const log = moduleLogger('auth');

/** Stored under a hash of the session id so a Redis dump never contains usable cookies. */
function sessionKey(sid: string): string {
  return `auth:sess:${createHash('sha256').update(sid).digest('hex')}`;
}

interface SessionRecord {
  userId: number;
  role: Role;
  createdAt: number;
  lastSeenAt: number;
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['userId'] === 'number' &&
    (v['role'] === 'USER' || v['role'] === 'ADMIN') &&
    typeof v['createdAt'] === 'number' &&
    typeof v['lastSeenAt'] === 'number'
  );
}

export const sessionService = {
  /** Creates a session and returns the raw session id (only ever sent to the client as a cookie). */
  async create(userId: number, role: Role): Promise<string> {
    const sid = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
    const now = Date.now();
    const record: SessionRecord = { userId, role, createdAt: now, lastSeenAt: now };
    await coordGuard(() => coordRedis.set(sessionKey(sid), JSON.stringify(record), 'EX', SESSION_IDLE_TTL_SECONDS));
    return sid;
  },

  /**
   * Resolves a session id to its user (pipeline step 5). Returns null when unknown, malformed or past
   * the absolute lifetime. Throws when redis-coord is unavailable (caller reports SERVICE_DEGRADED).
   * Refreshes the sliding TTL at most every SESSION_TOUCH_INTERVAL_SECONDS.
   */
  async resolve(sid: string): Promise<{ userId: number; role: Role } | null> {
    const key = sessionKey(sid);
    const raw = await coordRedis.get(key);
    if (raw === null) return null;

    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      record = undefined;
    }
    if (!isSessionRecord(record)) {
      await coordRedis.del(key);
      return null;
    }

    const now = Date.now();
    const ageSeconds = (now - record.createdAt) / 1000;
    if (ageSeconds >= SESSION_ABSOLUTE_MAX_SECONDS) {
      await coordRedis.del(key);
      return null;
    }

    if ((now - record.lastSeenAt) / 1000 >= SESSION_TOUCH_INTERVAL_SECONDS) {
      const ttl = Math.max(1, Math.min(SESSION_IDLE_TTL_SECONDS, Math.ceil(SESSION_ABSOLUTE_MAX_SECONDS - ageSeconds)));
      try {
        // XX: only if it still exists, so a touch can never resurrect a session that was just logged out.
        await coordRedis.set(key, JSON.stringify({ ...record, lastSeenAt: now }), 'EX', ttl, 'XX');
      } catch (error) {
        // The session itself is valid; a failed refresh only shortens its sliding window.
        log.warn({ err: error instanceof Error ? error.message : String(error) }, 'session touch failed');
      }
    }
    return { userId: record.userId, role: record.role };
  },

  async delete(sid: string): Promise<void> {
    await coordGuard(() => coordRedis.del(sessionKey(sid)));
  }
};
