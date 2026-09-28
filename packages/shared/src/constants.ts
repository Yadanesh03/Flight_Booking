/**
 * ALL tunable numbers live here (Architecture spec, Section 6).
 * Never hard-code any of these values elsewhere.
 *
 * Values the spec marks "(env)" are defaults here; the API config loader
 * (apps/api/src/platform/config.ts) applies environment overrides ONLY when NODE_ENV=test.
 */

// ---------------------------------------------------------------------------
// 6.1 Holds and booking
// ---------------------------------------------------------------------------

/** (env, test only) Hold TTL. Enough for passenger details + payment; short enough to limit squatting. */
export const HOLD_TTL_SECONDS = 600;
/** Also the maximum number of seats per booking. */
export const MAX_SEATS_PER_FLIGHT_HOLD = 6;
/**
 * Sanity cap on the size of a hold request body. Requests above MAX_SEATS_PER_FLIGHT_HOLD but within
 * this cap are rejected by the hold script with 422 HOLD_LIMIT_EXCEEDED (spec test 8), not 400.
 */
export const HOLD_REQUEST_MAX_SEAT_IDS = 100;
/** Allows an outbound + return leg; prevents hoarding. */
export const MAX_FLIGHTS_WITH_ACTIVE_HOLDS = 2;
/** Newly acquired hold seats per user per hour. Stops release-and-re-hold cycling. */
export const HOLD_ACQUISITIONS_PER_HOUR = 40;
/** No holds or bookings within this many minutes of departure. */
export const BOOKING_CUTOFF_MINUTES = 60;
/** (env, test only) A PENDING booking older than this is treated as abandoned (crash recovery without workers). */
export const PENDING_BOOKING_STALE_SECONDS = 120;
/** Simulated payment latency window (random, inclusive). Makes concurrency tests realistic. */
export const PAYMENT_SIM_LATENCY_MIN_MS = 300;
export const PAYMENT_SIM_LATENCY_MAX_MS = 800;
/** Session `innodb_lock_wait_timeout` for the confirm transaction. */
export const BOOKING_TX_LOCK_WAIT_TIMEOUT_S = 5;
/** Retries on deadlock (1213) / lock-wait timeout (1205). */
export const BOOKING_TX_MAX_RETRIES = 3;
/** Backoff before retry N (1-based), plus 0..BOOKING_TX_RETRY_JITTER_MS of jitter. */
export const BOOKING_TX_RETRY_BACKOFF_MS = [25, 50, 100] as const;
export const BOOKING_TX_RETRY_JITTER_MS = 25;
/** Cursor pagination for booking history. */
export const BOOKINGS_PAGE_SIZE = 20;
export const BOOKINGS_PAGE_SIZE_MAX = 50;
/** Retries when a generated booking reference collides on the unique index. */
export const BOOKING_REF_MAX_ATTEMPTS = 5;
/** 6 characters, no 0/O/1/I. */
export const BOOKING_REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const BOOKING_REF_LENGTH = 6;
/** Retry-After (seconds) returned with 409 BOOKING_IN_PROGRESS. */
export const BOOKING_IN_PROGRESS_RETRY_AFTER_S = 2;

// ---------------------------------------------------------------------------
// 6.2 Sessions and auth
// ---------------------------------------------------------------------------

export const SESSION_IDLE_TTL_SECONDS = 86_400; // 24 h, sliding
export const SESSION_ABSOLUTE_MAX_SECONDS = 604_800; // 7 d
export const SESSION_TOUCH_INTERVAL_SECONDS = 900; // refresh TTL at most every 15 min
export const SESSION_TOKEN_BYTES = 32;
export const SESSION_COOKIE_NAME = 'sid';
export const BCRYPT_COST = 12;
export const PASSWORD_MIN_LENGTH = 8;
/** bcrypt input limit. */
export const PASSWORD_MAX_BYTES = 72;
export const LOGIN_FAILURES_BEFORE_LOCK = 10;
export const LOGIN_FAILURE_WINDOW_SECONDS = 900;
export const LOGIN_LOCK_SECONDS = 900;

// ---------------------------------------------------------------------------
// 6.3 Caching
// ---------------------------------------------------------------------------

export const CACHE_TTL_SECONDS = {
  airports: 86_400,
  flightDetails: 600,
  searchResults: 60,
  /** Seat metadata (layout + prices): immutable after publish. */
  seatMeta: 21_600,
  /** Seat status hash: write-through on booking commit, version-guarded fills. */
  seatStatus: 600,
  /** Negative cache (not found). */
  negative: 30,
  /** Seat status version counter. */
  seatStatusVersion: 604_800
} as const;
/** TTL jitter, ±10 %, applied to every cache TTL. */
export const CACHE_TTL_JITTER = 0.1;
export const FILL_LOCK_TTL_MS = 5000;
export const FILL_WAIT_POLL_MS = 50;
export const FILL_WAIT_POLL_JITTER_MS = 25;
export const FILL_WAIT_MAX_MS = 2000;
/** Sentinel stored for negative-cached (not found) entries. */
export const NEGATIVE_CACHE_SENTINEL = '__NF__';

// ---------------------------------------------------------------------------
// 6.4 Rate limits (sliding window counter)
// ---------------------------------------------------------------------------

export interface RateLimitRule {
  /** Maximum weighted requests per window. */
  limit: number;
  windowMs: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export const RATE_LIMITS = {
  /** IP, every /api/* request */
  global: { limit: 300, windowMs: MINUTE_MS },
  /** IP, POST /api/auth/login */
  auth_login: { limit: 10, windowMs: MINUTE_MS },
  /** IP, POST /api/auth/register */
  auth_register: { limit: 5, windowMs: HOUR_MS },
  /** user ID, else IP; all GET routes */
  read: { limit: 120, windowMs: MINUTE_MS },
  /** user ID; PUT / DELETE /api/flights/:id/holds */
  holds: { limit: 20, windowMs: MINUTE_MS },
  /** user ID; POST /api/bookings */
  bookings: { limit: 10, windowMs: MINUTE_MS },
  /** user ID; /api/admin/* */
  admin: { limit: 60, windowMs: MINUTE_MS }
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitRuleName = keyof typeof RATE_LIMITS;

/** At most one RATE_LIMIT_BYPASSED / CACHE_UNAVAILABLE warning per this many ms. */
export const DEGRADED_LOG_THROTTLE_MS = 10_000;

// ---------------------------------------------------------------------------
// 6.5 Runtime
// ---------------------------------------------------------------------------

export const REQUEST_BODY_LIMIT = '100kb';
export const SERVER_REQUEST_TIMEOUT_MS = 15_000;
export const MYSQL_CONNECTION_LIMIT = 20;
export const MYSQL_QUEUE_LIMIT = 100;
export const MYSQL_CONNECT_TIMEOUT_MS = 5000;
export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;
/** Frontend seat-map poll interval. */
export const SEAT_MAP_POLL_INTERVAL_MS = 5000;
/** Health check dependency timeout. */
export const READINESS_TIMEOUT_MS = 1000;

// ---------------------------------------------------------------------------
// Redis memory (6.6) - documented here, enforced by infra/redis/*.conf
// ---------------------------------------------------------------------------

export const REDIS_CACHE_MAXMEMORY = '256mb';
export const REDIS_COORD_MAXMEMORY = '128mb';

// ---------------------------------------------------------------------------
// Flights (Sections 13 and 22)
// ---------------------------------------------------------------------------

/** Search accepts dates from today up to this many days ahead. */
export const SEARCH_MAX_DAYS_AHEAD = 90;
/** Pricing rule: price = base * cabinMultiplier + seatTypeSurcharge (Section 13.3). */
export const PRICE_BUSINESS_MULTIPLIER = 2.5;
export const PRICE_ECONOMY_MULTIPLIER = 1.0;
export const PRICE_WINDOW_SURCHARGE = 350;
export const PRICE_AISLE_SURCHARGE = 250;
export const PRICE_MIDDLE_SURCHARGE = 0;
/** Admin flight list page size. */
export const ADMIN_LIST_PAGE_SIZE = 50;
/** Currency for all money. */
export const CURRENCY = 'INR';
/** Seat layout limits for admin-created aircraft. */
export const AIRCRAFT_MAX_ROWS = 80;
export const AIRCRAFT_MAX_BUSINESS_ROWS = 20;
