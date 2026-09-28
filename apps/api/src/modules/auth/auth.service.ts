import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import {
  BCRYPT_COST,
  LOGIN_FAILURES_BEFORE_LOCK,
  LOGIN_FAILURE_WINDOW_SECONDS,
  LOGIN_LOCK_SECONDS,
  type LoginInput,
  type RegisterInput,
  type Role,
  type UserDto
} from '@flight/shared';
import { db } from '../../platform/db.js';
import { AppError, isDuplicateKey } from '../../platform/errors.js';
import { moduleLogger } from '../../platform/logger.js';
import { coordGuard, coordRedis } from '../../platform/redis.js';
import { sessionService } from './session.service.js';
import type { UserRow } from './schema.js';
import { usersRepository } from './users.repository.js';

const log = moduleLogger('auth');

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
/** Short hash for log lines: identifies a subject without storing the email. */
const logId = (value: string): string => sha256(value).slice(0, 12);

/**
 * A valid bcrypt hash of a random secret, computed once at startup. Compared against when the email
 * is unknown so login always costs one bcrypt.compare (prevents user enumeration by timing).
 */
const dummyHash: Promise<string> = bcrypt.hash(randomBytes(16).toString('hex'), BCRYPT_COST);

function toUserDto(row: UserRow): UserDto {
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}

const failKey = (email: string): string => `auth:loginfail:${sha256(email)}`;
const lockKey = (email: string): string => `auth:loginlock:${sha256(email)}`;

export interface AuthResult {
  user: UserDto;
  sid: string;
}

export interface CreateUserInput {
  name: string;
  email: string;
  password: string;
  role?: Role;
}

export const authService = {
  /**
   * Inserts a user with a bcrypt-hashed password. Duplicate email -> 409 EMAIL_TAKEN. Used by
   * `register` and by the seed script (the only place that creates ADMIN users).
   */
  async createUser(input: CreateUserInput): Promise<UserDto> {
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
    try {
      const id = await usersRepository.insert(db, {
        name: input.name,
        email: input.email,
        passwordHash,
        role: input.role ?? 'USER'
      });
      const row = await usersRepository.findById(db, id);
      if (row === undefined) throw new Error('user vanished after insert');
      return toUserDto(row);
    } catch (error) {
      if (isDuplicateKey(error, 'uq_users_email')) throw new AppError('EMAIL_TAKEN');
      throw error;
    }
  },

  /** Looks a user up by (already lower-cased) email. Used by the seed script to find existing demo users. */
  async findUserByEmail(email: string): Promise<UserDto | undefined> {
    const row = await usersRepository.findByEmail(db, email.trim().toLowerCase());
    return row === undefined ? undefined : toUserDto(row);
  },

  /** POST /api/auth/register (Section 11.1). */
  async register(input: RegisterInput): Promise<AuthResult> {
    const user = await this.createUser({ name: input.name, email: input.email, password: input.password });
    const sid = await sessionService.create(user.id, user.role);
    log.info({ event: 'AUTH_REGISTER', userId: user.id }, 'AUTH_REGISTER');
    return { user, sid };
  },

  /**
   * POST /api/auth/login (Section 11.2).
   * @param existingSid the request's current session cookie, if any (deleted: a fresh id is always
   *   issued on login, which is the session-fixation defence).
   * @param clientIp only used (hashed) for logging.
   */
  async login(input: LoginInput, existingSid: string | undefined, clientIp: string): Promise<AuthResult> {
    const { email, password } = input;

    // 2. Locked accounts are refused before any password work.
    const lockTtlMs = await coordGuard(() => coordRedis.pttl(lockKey(email)));
    if (lockTtlMs > 0) {
      throw new AppError('ACCOUNT_TEMPORARILY_LOCKED', { retryAfterSeconds: Math.ceil(lockTtlMs / 1000) });
    }

    // 3. Always run bcrypt.compare, against a dummy hash when the user does not exist.
    const row = await usersRepository.findByEmail(db, email);
    const matches = await bcrypt.compare(password, row?.passwordHash ?? (await dummyHash));

    if (row === undefined || !matches) {
      await this.recordFailure(email, clientIp);
      // Same message whether or not the email exists.
      throw new AppError('INVALID_CREDENTIALS');
    }

    // 5. Success: clear the failure counter, drop any old session, issue a new one.
    await coordGuard(() => coordRedis.del(failKey(email)));
    if (existingSid !== undefined) await sessionService.delete(existingSid);
    const sid = await sessionService.create(row.id, row.role);
    log.info({ event: 'AUTH_LOGIN_SUCCESS', userId: row.id }, 'AUTH_LOGIN_SUCCESS');
    return { user: toUserDto(row), sid };
  },

  /** 4. Counts a failed login; at LOGIN_FAILURES_BEFORE_LOCK sets the lock and clears the counter. */
  async recordFailure(email: string, clientIp: string): Promise<void> {
    const key = failKey(email);
    const results = await coordGuard(() =>
      // EXPIRE ... NX only sets a TTL on a counter that has none, i.e. the first failure of the window.
      coordRedis.multi().incr(key).expire(key, LOGIN_FAILURE_WINDOW_SECONDS, 'NX').exec()
    );
    const count = Number(results?.[0]?.[1] ?? 0);
    log.warn(
      { event: 'AUTH_LOGIN_FAILED', emailHash: logId(email), ipHash: logId(clientIp), failures: count },
      'AUTH_LOGIN_FAILED'
    );
    if (count >= LOGIN_FAILURES_BEFORE_LOCK) {
      await coordGuard(() => coordRedis.multi().set(lockKey(email), '1', 'EX', LOGIN_LOCK_SECONDS).del(key).exec());
      log.warn({ event: 'AUTH_ACCOUNT_LOCKED', emailHash: logId(email) }, 'AUTH_ACCOUNT_LOCKED');
    }
  },

  /** POST /api/auth/logout (Section 11.3). */
  async logout(sid: string | undefined, userId: number): Promise<void> {
    if (sid !== undefined) await sessionService.delete(sid);
    log.info({ event: 'AUTH_LOGOUT', userId }, 'AUTH_LOGOUT');
  },

  /**
   * GET /api/auth/me (Section 11.3). If the user no longer exists the session is deleted and the
   * caller gets 401.
   */
  async me(userId: number, sid: string | undefined): Promise<UserDto> {
    const row = await usersRepository.findById(db, userId);
    if (row === undefined) {
      if (sid !== undefined) await sessionService.delete(sid);
      throw new AppError('UNAUTHENTICATED');
    }
    return toUserDto(row);
  }
};
