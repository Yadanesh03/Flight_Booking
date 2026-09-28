import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { HOLD_TTL_SECONDS, PENDING_BOOKING_STALE_SECONDS } from '@flight/shared';

/** Parses 'true'/'false' (case-insensitive, trimmed). Anything else is a config error. */
const boolFromEnv = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['true', 'false']))
  .transform((value) => value === 'true');

/** An env var that may be present-but-empty (e.g. `SERVE_STATIC_DIR=`): empty means unset. */
const optionalString = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.trim()));

const optionalPositiveInt = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value.trim() === '') return undefined;
    const parsed = Number(value.trim());
    if (!Number.isInteger(parsed) || parsed <= 0) {
      ctx.addIssue({ code: 'custom', message: 'must be a positive integer' });
      return z.NEVER;
    }
    return parsed;
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url().startsWith('mysql://'),
  REDIS_CACHE_URL: z.string().url().default('redis://localhost:6379'),
  REDIS_COORD_URL: z.string().url().default('redis://localhost:6380'),
  ALLOWED_ORIGIN: z.string().url().default('http://localhost:5173'),
  COOKIE_SECURE: boolFromEnv.default(false),
  TRUST_PROXY: boolFromEnv.default(false),
  SERVE_STATIC_DIR: optionalString,
  HOLD_TTL_SECONDS: optionalPositiveInt,
  PENDING_BOOKING_STALE_SECONDS: optionalPositiveInt,
  SEED_ADMIN_EMAIL: optionalString,
  SEED_ADMIN_PASSWORD: optionalString
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  isTest: boolean;
  isProduction: boolean;
  port: number;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  databaseUrl: string;
  redisCacheUrl: string;
  redisCoordUrl: string;
  /** Origin (scheme://host[:port], no path) that mutating requests must come from. */
  allowedOrigin: string;
  cookieSecure: boolean;
  trustProxy: boolean;
  serveStaticDir: string | undefined;
  /** Effective hold TTL. The env override is honoured only when NODE_ENV=test. */
  holdTtlSeconds: number;
  /** Effective stale-PENDING threshold. The env override is honoured only when NODE_ENV=test. */
  pendingBookingStaleSeconds: number;
  seedAdminEmail: string | undefined;
  seedAdminPassword: string | undefined;
}

/**
 * Validates the environment. Throws a readable error listing every problem; `config` (below) turns
 * that into a process exit at startup so a bad config never boots.
 */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n${problems.join('\n')}`);
  }
  const e = parsed.data;
  const isTest = e.NODE_ENV === 'test';
  // DECISION: allowedOrigin is normalised to `URL.origin` so a trailing slash or path in the env value
  // cannot make the Origin comparison in the CSRF check silently never match.
  const allowedOrigin = new URL(e.ALLOWED_ORIGIN).origin;
  return {
    nodeEnv: e.NODE_ENV,
    isTest,
    isProduction: e.NODE_ENV === 'production',
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    redisCacheUrl: e.REDIS_CACHE_URL,
    redisCoordUrl: e.REDIS_COORD_URL,
    allowedOrigin,
    cookieSecure: e.COOKIE_SECURE,
    trustProxy: e.TRUST_PROXY,
    serveStaticDir: e.SERVE_STATIC_DIR,
    holdTtlSeconds: isTest ? (e.HOLD_TTL_SECONDS ?? HOLD_TTL_SECONDS) : HOLD_TTL_SECONDS,
    pendingBookingStaleSeconds: isTest
      ? (e.PENDING_BOOKING_STALE_SECONDS ?? PENDING_BOOKING_STALE_SECONDS)
      : PENDING_BOOKING_STALE_SECONDS,
    seedAdminEmail: e.SEED_ADMIN_EMAIL,
    seedAdminPassword: e.SEED_ADMIN_PASSWORD
  };
}

/** Dev convenience: load the repo-root `.env` if present. Real environment variables always win. */
function loadDotEnv(): void {
  for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
  }
}

function loadOrExit(): AppConfig {
  if (process.env['NODE_ENV'] !== 'test') loadDotEnv();
  try {
    return loadConfig(process.env);
  } catch (error) {
    // Logger is not available yet (it depends on config), so write directly.
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

export const config: AppConfig = loadOrExit();
