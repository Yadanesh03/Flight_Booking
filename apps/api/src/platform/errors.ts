import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { ERROR_MESSAGES, ERROR_STATUS, type ApiErrorBody, type ErrorCode } from '@flight/shared';
import { logger } from './logger.js';

export interface AppErrorOptions {
  message?: string;
  details?: Record<string, unknown>;
  /** Seconds. Sets the `Retry-After` header. Always set for 429 and 409 BOOKING_IN_PROGRESS. */
  retryAfterSeconds?: number;
  cause?: unknown;
}

/** The only error type services and controllers throw deliberately. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(options.message ?? ERROR_MESSAGES[code], options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    if (options.details !== undefined) this.details = options.details;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** mysql2 / network error codes that mean "the database is unreachable or saturated". */
const DB_UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  'PROTOCOL_CONNECTION_LOST',
  'ER_CON_COUNT_ERROR',
  'ER_SERVER_SHUTDOWN',
  'POOL_ENQUEUELIMIT',
  'POOL_CLOSED'
]);

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** Walks `error.cause` so drizzle-wrapped driver errors are still recognised. */
export function findDbErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    const code = errorCodeOf(current);
    if (code !== undefined) return code;
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

export function isDbUnavailable(error: unknown): boolean {
  const code = findDbErrorCode(error);
  return code !== undefined && DB_UNAVAILABLE_CODES.has(code);
}

/** True for a MySQL duplicate-key violation, optionally on a specific unique index. */
export function isDuplicateKey(error: unknown, indexName?: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (errorCodeOf(current) === 'ER_DUP_ENTRY') {
      if (indexName === undefined) return true;
      const message = (current as { message?: unknown }).message;
      // mysql2 message: "Duplicate entry 'x' for key 'bookings.uq_user_idempotency'"
      return typeof message === 'string' && message.includes(indexName);
    }
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/** MySQL deadlock (1213) or lock-wait timeout (1205). */
export function isRetryableTxError(error: unknown): boolean {
  const code = findDbErrorCode(error);
  return code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT';
}

interface HttpishError {
  status?: number;
  statusCode?: number;
  type?: string;
}

/** Converts anything thrown into the public error model. No stack traces or internals leak. */
export function toApiError(error: unknown): { status: number; body: ApiErrorBody['error']; retryAfterSeconds?: number } {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details })
      },
      ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds })
    };
  }
  if (error instanceof ZodError) {
    return {
      status: ERROR_STATUS.VALIDATION_ERROR,
      body: {
        code: 'VALIDATION_ERROR',
        message: ERROR_MESSAGES.VALIDATION_ERROR,
        details: {
          issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
        }
      }
    };
  }
  const http = error as HttpishError | null;
  // body-parser errors: malformed JSON, payload too large, unsupported charset...
  if (
    http !== null &&
    typeof http === 'object' &&
    typeof http.type === 'string' &&
    http.type.startsWith('entity.') &&
    typeof (http.status ?? http.statusCode) === 'number'
  ) {
    return {
      status: ERROR_STATUS.VALIDATION_ERROR,
      body: {
        code: 'VALIDATION_ERROR',
        message: http.type === 'entity.too.large' ? 'The request body is too large.' : 'The request body is not valid JSON.'
      }
    };
  }
  if (isDbUnavailable(error)) {
    return {
      status: ERROR_STATUS.SERVICE_UNAVAILABLE,
      body: { code: 'SERVICE_UNAVAILABLE', message: ERROR_MESSAGES.SERVICE_UNAVAILABLE }
    };
  }
  return {
    status: ERROR_STATUS.INTERNAL_ERROR,
    body: { code: 'INTERNAL_ERROR', message: ERROR_MESSAGES.INTERNAL_ERROR }
  };
}

/** Terminal error middleware (Section 17). Must be registered last. */
export const errorMiddleware: ErrorRequestHandler = (error: unknown, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const { status, body, retryAfterSeconds } = toApiError(error);
  const log = req.log ?? logger;
  if (status >= 500) log.error({ err: error, code: body.code }, 'request failed');
  if (retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterSeconds))));
  const payload: ApiErrorBody = { error: body, requestId: req.requestId };
  res.status(status).json(payload);
};

/** 404 for unmatched `/api/*` routes. */
export const notFoundHandler: RequestHandler = (req) => {
  throw new AppError('NOT_FOUND', { message: `No route for ${req.method} ${req.path}.` });
};
