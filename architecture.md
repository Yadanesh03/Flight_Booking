# Flight Booking System — Architecture Specification (v3, Modular Monolith, Final)

> **For Claude Code:** This document is the single source of truth for the project. Implement exactly what is described. Do not add features, services, queues, or infrastructure that are not listed here. Where an implementation detail is unspecified, choose the simplest option consistent with the invariants in Section 26, and leave a short `// DECISION:` comment explaining the choice. All tunable numbers live in one constants file (Section 6); never hard-code them elsewhere.

---

## 1. Project Overview

A full-stack flight booking platform built to demonstrate backend and system-design fundamentals: session management, caching, cache-stampede protection, rate limiting, seat holds with TTLs, concurrency control, database transactions and row locking, and idempotency, inside a cleanly bounded modular monolith.

Users can:
- Register, log in, log out.
- Search flights by route and date.
- View flight details and a live seat map.
- Hold one or more seats (up to 6) for 10 minutes.
- Enter passenger details and pay (simulated).
- Receive a confirmed booking with a booking reference.
- View booking history and booking details.

Admins can:
- Create aircraft with auto-generated seat layouts.
- Create, edit, publish, and cancel flights.

All flight data is synthetic (e.g. `AI-101 BOM→DEL`, `6E-312 BOM→HYD`). No real airline or payment integrations.

---

## 2. Scope

### Included
- One backend application (modular monolith) with modules: `auth`, `flights`, `booking`, plus shared `platform` code.
- React SPA frontend, served same-origin.
- Server-side sessions in Redis with HttpOnly cookies.
- MySQL 8.4 (InnoDB) as the source of truth, one database.
- Two Redis instances: cache (LRU) and coordination (no eviction, persisted).
- Read-through caching with stampede protection (in-process singleflight + distributed fill lock).
- Redis-backed rate limiting (sliding window counter) and login lockout.
- Atomic multi-seat holds with TTL via Lua scripts.
- Hold abuse limits (seats per flight, flights per user, hourly acquisition quota).
- MySQL transactions with ordered `SELECT ... FOR UPDATE` as the final correctness check.
- Idempotent booking creation with a claim-first PENDING record.
- Simulated payment.
- Health/readiness checks, structured logs, request IDs, graceful shutdown.
- Admin UI for aircraft and flights.

### Excluded (do not implement)
- Microservices, API gateway as a separate process, service-to-service HTTP.
- Kafka, RabbitMQ, Redis Streams, or any message queue / event bus.
- Background workers or cron jobs.
- Kubernetes, sharding, read replicas, multi-region.
- Real payments, refunds, booking cancellation by users.
- Dynamic pricing, baggage, meals, loyalty, PNR/e-ticket issuance.
- Email/SMS notifications, OAuth / social login.

---

## 3. Architecture Overview

```text
                     ┌──────────────────────────────┐
                     │   React SPA (Vite)           │
                     │   apps/web                   │
                     └──────────────┬───────────────┘
                                    │ same-origin /api/*
                                    │ (Vite proxy in dev; API serves static build in prod)
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  API Application (Node.js + Express)  :8080          apps/api            │
│                                                                          │
│  HTTP pipeline (platform):                                               │
│   request ID → security headers → origin check → global rate limit →     │
│   session resolution → route auth → route rate limit → module router     │
│                                                                          │
│  ┌──────────────┐    ┌──────────────────┐    ┌────────────────────────┐  │
│  │ auth module  │    │ flights module   │    │ booking module         │  │
│  │ users,       │    │ airports,        │◀───│ inventory (flight_     │  │
│  │ sessions,    │    │ aircraft, seats, │    │ seats), holds,         │  │
│  │ login lockout│    │ flights, search, │───▶│ bookings, payment sim, │  │
│  │              │    │ admin catalog,   │    │ booking history        │  │
│  │              │    │ publish          │    │                        │  │
│  └──────┬───────┘    └────────┬─────────┘    └───────────┬────────────┘  │
│         │   modules talk only through each other's public service API    │
│  ┌──────┴────────────────────┴───────────────────────────┴────────────┐  │
│  │ platform: config, logger, errors, db pool, redis clients,          │  │
│  │ cache (getOrFill), rate limiter, Lua scripts, health, shutdown     │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└───────────────┬───────────────────────────────┬──────────────────────────┘
                │                               │
                ▼                               ▼
     ┌─────────────────────┐        ┌──────────────────────────────────────┐
     │ MySQL 8.4           │        │ redis-cache :6379  (allkeys-lru)     │
     │ database:           │        │   flight/search/seat caches          │
     │ flight_booking      │        ├──────────────────────────────────────┤
     │ (source of truth)   │        │ redis-coord :6380  (noeviction, AOF) │
     └─────────────────────┘        │   sessions, rate limits, lockout,    │
                                    │   seat holds, fill locks             │
                                    └──────────────────────────────────────┘
```

### 3.1 Why a modular monolith
- Every interesting problem in this project (holds, row locking, idempotency, stampede protection, rate limiting) is fully present in a single deployable.
- Confirming a booking must atomically mark seats BOOKED and create the booking. In one application with one database this is a plain local ACID transaction, with no sagas or compensation logic.
- Module boundaries are enforced in code (3.3) so the booking module could later be extracted into its own service without redesign. This is a deliberate, explainable decision, not a shortcut.

### 3.2 Module responsibilities

| Module | Owns (tables) | Responsibilities |
|---|---|---|
| `auth` | `users` | Register, login, logout, `me`. Password hashing. Session create/delete. Login lockout. |
| `flights` | `airports`, `aircraft`, `seats`, `flights` | Catalog, search, flight details, admin CRUD, seat layout generation, seat pricing, publishing flights. |
| `booking` | `flight_seats`, `bookings`, `booking_seats` | Seat map, holds, booking creation, idempotency, payment simulation, booking history, admin inventory stats. |
| `platform` | none | HTTP pipeline middleware, config, logging, errors, DB pool + transaction helper, Redis clients, caching, rate limiting, Lua scripts, health, shutdown. |

`flight_seats` (per-flight seat state) belongs to `booking`, not `flights`, because it must change in the same transaction as `bookings`. `flights` owns the catalog (what exists); `booking` owns inventory (what is sold).

### 3.3 Module boundary rules (enforced)
1. Each module exposes a public API only through `modules/<name>/index.ts` (services and types). Everything else in the module is private.
2. A module **never** queries another module's tables. It calls the other module's exported service instead.
3. Cross-module imports are restricted with ESLint `no-restricted-imports`: `modules/*/**` may import from `modules/<other>` (the index) but not from `modules/<other>/**` internals.
4. `platform` never imports from modules. Modules may import from `platform`.
5. The only cross-module calls are listed below. Do not add others without a concrete need.

| Caller → Callee | Function | Purpose |
|---|---|---|
| `flights` → `booking` | `inventoryService.createInventory(tx, flightId, seats)` | Create `flight_seats` rows inside the publish transaction |
| `booking` → `flights` | `flightsService.getBookability(flightId)` | `{bookable, reason, snapshot:{flightNumber, from, to, departureTime, arrivalTime, status}}` |
| `booking` → `flights` | `flightsService.getLayout(flightId)` | `{layoutColumns, totalRows}` for the seat map |
| `booking` → `auth` | none | User identity comes from `req.user`, set by the pipeline |

Cross-module calls are plain function calls. The `tx` argument lets a caller include another module's writes in its own transaction (used only by publish).

Foreign keys between tables of different modules are allowed in the database for integrity; they are noted in Section 8 and would be dropped if a module were extracted.

---

## 4. Technology Stack

| Area | Choice |
|---|---|
| Runtime | Node.js 22 LTS or newer |
| Language | TypeScript 5 (`strict: true`, no `any`) |
| Monorepo | npm workspaces (`apps/api`, `apps/web`, `packages/shared`) |
| HTTP framework | Express 5 |
| Validation | `zod` (request bodies, query params, env config) |
| MySQL | MySQL 8.4 LTS, InnoDB, `utf8mb4`, driver `mysql2` |
| ORM / migrations | Drizzle ORM + drizzle-kit (raw `sql` allowed in the booking transaction) |
| Redis | Redis 7.4+ (required for hash-field expiry `HEXPIRE`), client `ioredis` |
| Password hashing | `bcrypt`, cost 12 |
| Logging | `pino` (JSON) + `pino-http` |
| Security headers | `helmet` |
| Testing | `vitest`, `supertest`, `autocannon` |
| Frontend | React 19, Vite, TypeScript, React Router, TanStack Query v5, Tailwind CSS v4 |
| Local infra | Docker Compose |

---

## 5. Repository Layout

```text
flight-booking/
├── package.json                  # workspaces; scripts: dev, build, test, seed, lint, migrate
├── docker-compose.yml            # mysql, redis-cache, redis-coord; "app" profile adds api
├── .env.example
├── infra/
│   ├── mysql/init/01-database.sql
│   └── redis/
│       ├── redis-cache.conf
│       └── redis-coord.conf
├── packages/
│   └── shared/src/
│       ├── constants.ts          # ALL tunable numbers (Section 6)
│       ├── errorCodes.ts         # error codes (Section 17), shared with web
│       └── schemas/              # zod DTO schemas shared by api and web
├── apps/
│   ├── api/src/
│   │   ├── main.ts               # bootstrap, listen, shutdown
│   │   ├── app.ts                # express app + pipeline + module routers
│   │   ├── platform/
│   │   │   ├── config.ts         # zod env loader
│   │   │   ├── logger.ts
│   │   │   ├── errors.ts         # AppError + error middleware
│   │   │   ├── db.ts             # mysql2 pool, drizzle instance, withTransaction()
│   │   │   ├── redis.ts          # cacheRedis, coordRedis, Lua registration
│   │   │   ├── lua/              # *.lua scripts
│   │   │   ├── cache/            # getOrFill.ts, singleflight.ts, jitter.ts
│   │   │   ├── middleware/       # requestId, originCheck, session, requireAuth, rateLimit
│   │   │   ├── health.ts
│   │   │   └── shutdown.ts
│   │   ├── modules/
│   │   │   ├── auth/
│   │   │   │   ├── index.ts      # public API
│   │   │   │   ├── auth.routes.ts
│   │   │   │   ├── auth.controller.ts
│   │   │   │   ├── auth.service.ts
│   │   │   │   ├── session.service.ts
│   │   │   │   ├── users.repository.ts
│   │   │   │   └── schema.ts     # drizzle tables owned by module
│   │   │   ├── flights/          # same layout; + admin.routes.ts, pricing.ts, layout.ts
│   │   │   └── booking/          # same layout; + hold.service.ts, booking.service.ts,
│   │   │                         #   inventory.service.ts, payment.simulator.ts, seatCache.ts
│   │   ├── db/migrations/
│   │   └── seed/
│   └── web/                      # React SPA
└── tests/
    ├── integration/
    └── load/
```

Layering inside every module: `routes → controller → service → repository`. Controllers never touch the DB or Redis directly. Repositories contain no business rules. Services own transactions.

---

## 6. Configuration Constants

All values live in `packages/shared/src/constants.ts`. Values marked *(env)* may be overridden by environment variables **only when `NODE_ENV=test`**.

### 6.1 Holds and booking

| Constant | Value | Rationale |
|---|---|---|
| `HOLD_TTL_SECONDS` *(env)* | `600` (10 min) | Enough for passenger details + payment; short enough to limit squatting. |
| `MAX_SEATS_PER_FLIGHT_HOLD` | `6` | Also the max seats per booking. |
| `MAX_FLIGHTS_WITH_ACTIVE_HOLDS` | `2` | Allows an outbound + return leg; prevents hoarding. |
| `HOLD_EXTENSION` | not allowed | Re-requesting an already-held seat never resets its TTL. |
| `HOLD_ACQUISITIONS_PER_HOUR` | `40` seats/user | Stops release-and-re-hold cycling. |
| `BOOKING_CUTOFF_MINUTES` | `60` | No holds or bookings within 60 min of departure. |
| `PENDING_BOOKING_STALE_SECONDS` *(env)* | `120` | PENDING older than this is treated as abandoned (crash recovery without workers). |
| `PAYMENT_SIM_LATENCY_MS` | `300–800` random | Makes concurrency tests realistic. |
| `BOOKING_TX_LOCK_WAIT_TIMEOUT_S` | `5` | Session `innodb_lock_wait_timeout` for the confirm transaction. |
| `BOOKING_TX_MAX_RETRIES` | `3` | On deadlock (1213) / lock-wait timeout (1205). |
| `BOOKING_TX_RETRY_BACKOFF_MS` | `25, 50, 100` + 0–25 ms jitter | |
| `BOOKINGS_PAGE_SIZE` | `20` (max `50`) | Cursor pagination. |

### 6.2 Sessions and auth

| Constant | Value |
|---|---|
| `SESSION_IDLE_TTL_SECONDS` | `86400` (24 h, sliding) |
| `SESSION_ABSOLUTE_MAX_SECONDS` | `604800` (7 d) |
| `SESSION_TOUCH_INTERVAL_SECONDS` | `900` (refresh TTL at most every 15 min) |
| `SESSION_TOKEN_BYTES` | `32` |
| `BCRYPT_COST` | `12` |
| `PASSWORD_MIN_LENGTH` / `PASSWORD_MAX_BYTES` | `8` / `72` (bcrypt input limit) |
| `LOGIN_FAILURES_BEFORE_LOCK` | `10` within `900 s`, per account |
| `LOGIN_LOCK_SECONDS` | `900` |

### 6.3 Caching

| Cache | TTL | Notes |
|---|---|---|
| Airports list | `86400 s` | |
| Flight details | `600 s` | Deleted on admin write. |
| Search results | `60 s` | Also invalidated instantly via search version bump. |
| Seat metadata (layout + prices) | `21600 s` | Immutable after publish. |
| Seat status hash | `600 s` | Write-through on booking commit, version-guarded fills. |
| Negative cache (not found) | `30 s` | |
| TTL jitter | ±10 % | Applied to every cache TTL. |
| `FILL_LOCK_TTL_MS` | `5000` | |
| `FILL_WAIT_POLL_MS` | `50` + 0–25 ms jitter | |
| `FILL_WAIT_MAX_MS` | `2000` | Then read DB directly without writing the cache. |

### 6.4 Rate limits (sliding window counter)

| Rule | Subject | Limit | Applies to |
|---|---|---|---|
| `global` | IP | 300 / min | Every `/api/*` request |
| `auth_login` | IP | 10 / min | `POST /api/auth/login` |
| `auth_register` | IP | 5 / hour | `POST /api/auth/register` |
| `read` | user ID, else IP | 120 / min | All `GET` routes |
| `holds` | user ID | 20 / min | `PUT` / `DELETE /api/flights/:id/holds` |
| `bookings` | user ID | 10 / min | `POST /api/bookings` |
| `admin` | user ID | 60 / min | `/api/admin/*` |

Plus: login lockout (6.2) and hourly hold quota (6.1), enforced by the owning modules.

### 6.5 Runtime

| Constant | Value |
|---|---|
| Request body limit | `100 kb` |
| Server request timeout | `15000 ms` |
| MySQL pool | `connectionLimit 20`, `queueLimit 100`, `connectTimeout 5000 ms` |
| Graceful shutdown timeout | `10000 ms` |
| Frontend seat-map poll interval | `5000 ms` |

### 6.6 Redis memory

| Instance | maxmemory | Policy | Persistence |
|---|---|---|---|
| `redis-cache` | `256mb` | `allkeys-lru` | none |
| `redis-coord` | `128mb` | `noeviction` | AOF, `appendfsync everysec` |

---

## 7. Infrastructure

### 7.1 Ports

| Component | Port |
|---|---|
| Web (Vite dev) | 5173 |
| API | 8080 |
| MySQL | 3306 |
| redis-cache | 6379 |
| redis-coord | 6380 |

### 7.2 Run modes
- **Dev:** `docker compose up -d` (MySQL + both Redis). `npm run dev` runs the API (`tsx watch`) and web (Vite) on the host via `concurrently`.
- **App:** `docker compose --profile app up --build` also runs the API container, which serves the built SPA. Only port 8080 needs to be published.
- All containers have healthchecks; the API uses `depends_on: condition: service_healthy`.

### 7.3 MySQL
- Image `mysql:8.4`. Settings: `character-set-server=utf8mb4`, `collation-server=utf8mb4_0900_ai_ci`, `default-time-zone='+00:00'`, default `REPEATABLE-READ` isolation.
- `infra/mysql/init/01-database.sql` creates database `flight_booking` and user `app` with privileges only on it (plus a separate `flight_booking_test` database for integration tests).
- All timestamps are UTC `DATETIME(3)`.
- Migrations: `npm run migrate` (drizzle-kit). In dev, the API runs pending migrations on startup.

### 7.4 Redis
- Image `redis:7.4-alpine` for both.
- `redis-cache.conf`: `maxmemory 256mb`, `maxmemory-policy allkeys-lru`, `save ""`, `appendonly no`.
- `redis-coord.conf`: `maxmemory 128mb`, `maxmemory-policy noeviction`, `appendonly yes`, `appendfsync everysec`.
- All Lua scripts are registered with `ioredis.defineCommand` at startup.

### 7.5 Environment variables (validated with zod at startup; invalid config exits the process)

```text
NODE_ENV=development|test|production
PORT=8080
LOG_LEVEL=info
DATABASE_URL=mysql://app:***@localhost:3306/flight_booking
REDIS_CACHE_URL=redis://localhost:6379
REDIS_COORD_URL=redis://localhost:6380
ALLOWED_ORIGIN=http://localhost:5173
COOKIE_SECURE=false            # true in production
TRUST_PROXY=false
SERVE_STATIC_DIR=              # production: path to apps/web/dist
HOLD_TTL_SECONDS=600           # honoured only in test
PENDING_BOOKING_STALE_SECONDS=120  # honoured only in test
SEED_ADMIN_EMAIL=admin@example.com
SEED_ADMIN_PASSWORD=<set locally>
```

---

## 8. Data Model (MySQL DDL)

Drizzle schemas must produce exactly these tables. `row_no` is used instead of `row_number` because `ROW_NUMBER` is reserved in MySQL 8. Money is always `DECIMAL`, serialized to JSON as a string (e.g. `"5499.00"`). Currency is `INR`.

### 8.1 `auth` module

```sql
CREATE TABLE users (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(100)  NOT NULL,
  email         VARCHAR(255)  NOT NULL,            -- lowercased + trimmed
  password_hash VARCHAR(100)  NOT NULL,
  role          ENUM('USER','ADMIN') NOT NULL DEFAULT 'USER',
  created_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB;
```

### 8.2 `flights` module

```sql
CREATE TABLE airports (
  code      CHAR(3)      PRIMARY KEY,               -- IATA, e.g. BOM
  name      VARCHAR(120) NOT NULL,
  city      VARCHAR(80)  NOT NULL,
  country   VARCHAR(80)  NOT NULL,
  timezone  VARCHAR(40)  NOT NULL                   -- IANA, e.g. Asia/Kolkata
) ENGINE=InnoDB;

CREATE TABLE aircraft (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  aircraft_code  VARCHAR(20) NOT NULL,              -- registration-like, e.g. VT-EXA
  model          VARCHAR(40) NOT NULL,              -- e.g. A320neo
  layout_columns VARCHAR(20) NOT NULL,              -- e.g. 'ABC-DEF', '-' = aisle
  total_rows     SMALLINT UNSIGNED NOT NULL,
  business_rows  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  seat_count     SMALLINT UNSIGNED NOT NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_aircraft_code (aircraft_code)
) ENGINE=InnoDB;

CREATE TABLE seats (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  aircraft_id  BIGINT UNSIGNED NOT NULL,
  seat_number  VARCHAR(4) NOT NULL,                 -- e.g. 12A
  row_no       SMALLINT UNSIGNED NOT NULL,
  column_code  CHAR(1)    NOT NULL,
  cabin_class  ENUM('ECONOMY','BUSINESS') NOT NULL,
  seat_type    ENUM('WINDOW','MIDDLE','AISLE') NOT NULL,
  UNIQUE KEY uq_seat (aircraft_id, seat_number),
  CONSTRAINT fk_seats_aircraft FOREIGN KEY (aircraft_id) REFERENCES aircraft(id)
) ENGINE=InnoDB;

CREATE TABLE flights (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  flight_number       VARCHAR(10) NOT NULL,         -- e.g. AI-101
  aircraft_id         BIGINT UNSIGNED NOT NULL,
  source_airport      CHAR(3) NOT NULL,
  destination_airport CHAR(3) NOT NULL,
  departure_time      DATETIME(3) NOT NULL,         -- UTC
  arrival_time        DATETIME(3) NOT NULL,         -- UTC
  base_price          DECIMAL(10,2) NOT NULL,
  status              ENUM('DRAFT','SCHEDULED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_flight_departure (flight_number, departure_time),
  KEY idx_search (source_airport, destination_airport, status, departure_time),
  CONSTRAINT fk_flights_aircraft FOREIGN KEY (aircraft_id) REFERENCES aircraft(id),
  CONSTRAINT fk_flights_src FOREIGN KEY (source_airport) REFERENCES airports(code),
  CONSTRAINT fk_flights_dst FOREIGN KEY (destination_airport) REFERENCES airports(code),
  CONSTRAINT chk_route CHECK (source_airport <> destination_airport),
  CONSTRAINT chk_times CHECK (arrival_time > departure_time),
  CONSTRAINT chk_price CHECK (base_price > 0)
) ENGINE=InnoDB;
```

Seat generation rules (on aircraft creation):
- `layout_columns = 'ABC-DEF'` → columns A–F with an aisle between C and D.
- `seat_type`: first and last column → `WINDOW`; column adjacent to an aisle → `AISLE`; otherwise `MIDDLE`.
- Rows `1..business_rows` → `BUSINESS`; the rest → `ECONOMY`.
- `seat_count` = rows × columns, computed, never taken from input.
- An aircraft used by any non-DRAFT flight cannot have its seats modified (409).

### 8.3 `booking` module

```sql
CREATE TABLE flight_seats (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,   -- this is "seatId" in all booking APIs
  flight_id    BIGINT UNSIGNED NOT NULL,
  seat_id      BIGINT UNSIGNED NOT NULL,              -- seats.id
  seat_number  VARCHAR(4) NOT NULL,                   -- denormalized for single-table seat map reads
  row_no       SMALLINT UNSIGNED NOT NULL,
  column_code  CHAR(1)    NOT NULL,
  cabin_class  ENUM('ECONOMY','BUSINESS') NOT NULL,
  seat_type    ENUM('WINDOW','MIDDLE','AISLE') NOT NULL,
  price        DECIMAL(10,2) NOT NULL,
  status       ENUM('AVAILABLE','BOOKED') NOT NULL DEFAULT 'AVAILABLE',
  booking_id   BIGINT UNSIGNED NULL,
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_flight_seat (flight_id, seat_id),
  UNIQUE KEY uq_flight_seat_number (flight_id, seat_number),
  KEY idx_flight_status (flight_id, status),
  CONSTRAINT fk_fs_flight FOREIGN KEY (flight_id) REFERENCES flights(id),  -- cross-module FK
  CONSTRAINT fk_fs_seat   FOREIGN KEY (seat_id)   REFERENCES seats(id)     -- cross-module FK
) ENGINE=InnoDB;

CREATE TABLE bookings (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_ref      CHAR(6)  NOT NULL,                 -- public reference, e.g. K7XQ2M
  user_id          BIGINT UNSIGNED NOT NULL,
  flight_id        BIGINT UNSIGNED NOT NULL,
  status           ENUM('PENDING','CONFIRMED','FAILED') NOT NULL,
  failure_reason   VARCHAR(40) NULL,                  -- error code (Section 17) when FAILED
  total_amount     DECIMAL(12,2) NOT NULL DEFAULT 0,
  currency         CHAR(3) NOT NULL DEFAULT 'INR',
  idempotency_key  CHAR(36) NOT NULL,                 -- UUID from client
  request_hash     CHAR(64) NOT NULL,                 -- SHA-256 of canonical request body
  payment_method   ENUM('UPI','CARD','NETBANKING') NOT NULL,
  payment_ref      VARCHAR(40) NULL,
  flight_snapshot  JSON NULL,                         -- flight number, route, times at booking
  confirmed_at     DATETIME(3) NULL,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_booking_ref (booking_ref),
  UNIQUE KEY uq_user_idempotency (user_id, idempotency_key),
  KEY idx_user_created (user_id, created_at),
  KEY idx_flight (flight_id),
  CONSTRAINT fk_bookings_user   FOREIGN KEY (user_id)   REFERENCES users(id),    -- cross-module FK
  CONSTRAINT fk_bookings_flight FOREIGN KEY (flight_id) REFERENCES flights(id)   -- cross-module FK
) ENGINE=InnoDB;

CREATE TABLE booking_seats (
  booking_id      BIGINT UNSIGNED NOT NULL,
  flight_seat_id  BIGINT UNSIGNED NOT NULL,
  seat_number     VARCHAR(4) NOT NULL,
  price           DECIMAL(10,2) NOT NULL,
  passenger_name  VARCHAR(100) NOT NULL,
  passenger_age   TINYINT UNSIGNED NOT NULL,
  PRIMARY KEY (booking_id, flight_seat_id),
  UNIQUE KEY uq_booked_seat (flight_seat_id),        -- hard DB-level guard: one booking per flight seat
  CONSTRAINT fk_bs_booking FOREIGN KEY (booking_id) REFERENCES bookings(id),
  CONSTRAINT fk_bs_seat    FOREIGN KEY (flight_seat_id) REFERENCES flight_seats(id)
) ENGINE=InnoDB;
```

Notes:
- `booking_seats` rows exist only for CONFIRMED bookings, so `uq_booked_seat` is a second, schema-level guarantee against double booking on top of row locking. Safe because user cancellation is out of scope.
- `booking_ref`: 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0/O/1/I); on duplicate-key collision regenerate, max 5 tries.
- `request_hash`: SHA-256 hex of canonical JSON of `{flightId, seats (sorted by seatId, with passenger), payment}`, keys sorted, no whitespace.
- No passport/ID numbers are collected.

---

## 9. Redis Key Catalog

Prefixes: `auth:` (auth module), `fs:` (flights module), `bs:` (booking module), `rl:` (rate limiter), `lock:` (fill locks). A module only writes keys with its own prefix.

### 9.1 redis-coord (never evicted)

| Key | Type | Value | TTL |
|---|---|---|---|
| `auth:sess:<sha256(sid)>` | STRING | JSON `{userId, role, createdAt, lastSeenAt}` | 24 h sliding, ≤ 7 d absolute |
| `auth:loginfail:<sha256(email)>` | STRING | failure counter | 900 s from first failure |
| `auth:loginlock:<sha256(email)>` | STRING | `1` | 900 s |
| `rl:<rule>:<subject>:<windowIndex>` | STRING | counter | 2 × window |
| `bs:holds:<flightId>` | HASH | field `seatId` → `"<userId>\|<expiresAtMs>"` | per-field `HEXPIRE` = hold TTL |
| `bs:userholds:<userId>` | HASH | field `"<flightId>:<seatId>"` → `expiresAtMs` | per-field `HEXPIRE` = hold TTL |
| `bs:holdquota:<userId>:<hourIndex>` | STRING | seats acquired this hour | 7200 s |
| `fs:searchver` | STRING | search results version | none |
| `lock:fill:<cacheKey>` | STRING | UUID owner token | 5 s |

Sessions are stored under a hash of the session ID, so a Redis dump never contains usable cookies.

### 9.2 redis-cache (LRU, may be evicted at any time)

| Key | Type | Value | TTL |
|---|---|---|---|
| `fs:airports` | STRING | JSON list | 24 h |
| `fs:flight:<id>` | STRING | JSON details, or `__NF__` | 600 s / 30 s |
| `fs:search:v<ver>:<from>:<to>:<date>:<sort>` | STRING | JSON results | 60 s |
| `bs:seatmeta:<flightId>` | STRING | JSON layout + seat metadata + prices | 6 h |
| `bs:seats:<flightId>` | HASH | field `seatId` → `A` or `B` | 600 s |
| `bs:seatsver:<flightId>` | STRING | version, bumped on every committed booking | 7 d |

Losing any redis-cache key only costs a DB read. Correctness never depends on redis-cache.

---

## 10. HTTP Pipeline and Routes

### 10.1 Middleware order (platform)
1. **Request ID**: accept incoming `X-Request-Id` only if it is a valid UUID, else generate; echo in response; attach to the logger.
2. **helmet**, JSON body limit 100 kb, `pino-http` request logging.
3. **Origin check** for `POST`, `PUT`, `PATCH`, `DELETE`: `Origin` (or the origin of `Referer` if `Origin` is absent) must equal `ALLOWED_ORIGIN`; else 403 `FORBIDDEN`. Together with `SameSite=Lax` cookies this is the CSRF defence.
4. **Global rate limit** (`global`, by IP).
5. **Session resolution**: read `sid` cookie → `GET auth:sess:<sha256(sid)>` → check absolute expiry → set `req.user = {id, role}`. Touch the session if `lastSeenAt` is older than 15 min (update `lastSeenAt`, TTL = `min(idle TTL, remaining absolute lifetime)`).
6. **Route auth**: `public`, `optional` (user attached if present), `session` (401 if absent), `admin` (401 if absent, 403 if role ≠ ADMIN).
7. **Route rate limit** (Section 12).
8. **Module router** → controller.
9. **Error middleware** (Section 17).

In production the app also serves the SPA from `SERVE_STATIC_DIR` with an `index.html` fallback, so frontend and API share one origin.

### 10.2 Route table

| Method | Path | Module | Auth | Rate rule |
|---|---|---|---|---|
| POST | `/api/auth/register` | auth | public | `auth_register` |
| POST | `/api/auth/login` | auth | public | `auth_login` |
| POST | `/api/auth/logout` | auth | session | — |
| GET | `/api/auth/me` | auth | session | `read` |
| GET | `/api/airports` | flights | public | `read` |
| GET | `/api/flights` | flights | public | `read` |
| GET | `/api/flights/:flightId` | flights | public | `read` |
| GET | `/api/flights/:flightId/seats` | booking | optional | `read` |
| PUT, DELETE | `/api/flights/:flightId/holds` | booking | session | `holds` |
| GET | `/api/holds` | booking | session | `read` |
| POST | `/api/bookings` | booking | session | `bookings` |
| GET | `/api/bookings`, `/api/bookings/:bookingRef` | booking | session | `read` |
| * | `/api/admin/aircraft/*`, `/api/admin/flights/*` | flights | admin | `admin` |
| GET | `/api/admin/inventory/flights/:flightId` | booking | admin | `admin` |
| GET | `/health`, `/ready` | platform | public | — |

### 10.3 When redis-coord is down
- Session lookup fails → `session`/`admin` routes return 503 `SERVICE_DEGRADED`; `public`/`optional` routes continue without a user.
- Rate limiter fails **open** and logs `RATE_LIMIT_BYPASSED` (warn, at most once per 10 s).

---

## 11. Auth Module

### 11.1 Register — `POST /api/auth/register`
1. Validate `{name (1–100), email (valid, ≤ 255), password (≥ 8 chars, ≤ 72 bytes)}`. Lowercase and trim email.
2. Hash with bcrypt cost 12.
3. Insert user. Duplicate email → 409 `EMAIL_TAKEN`.
4. Create session (11.4), set cookie, return 201 `{user}`.

### 11.2 Login — `POST /api/auth/login`
1. Validate body.
2. If `auth:loginlock:<h>` exists → 429 `ACCOUNT_TEMPORARILY_LOCKED`, `Retry-After` = remaining TTL.
3. Load user by email. **Always** run `bcrypt.compare`, using a fixed dummy hash when the user does not exist (prevents enumeration by timing).
4. On failure: `INCR auth:loginfail:<h>` (set `EXPIRE 900` when the counter is new). At 10 → `SET auth:loginlock:<h> 1 EX 900` and delete the counter. Return 401 `INVALID_CREDENTIALS` with the same message whether or not the email exists.
5. On success: delete the failure counter. If the request has an existing `sid`, delete that session (**session fixation protection: always a new ID on login**). Create a new session, set the cookie, return 200 `{user}`.

### 11.3 Logout and me
- `POST /api/auth/logout`: delete the session key, clear the cookie, 204.
- `GET /api/auth/me`: return `{user}` for `req.user.id`; if the user no longer exists → delete session, 401.

### 11.4 Session creation
- `sid` = 32 random bytes, base64url.
- `SET auth:sess:<sha256(sid)> {userId, role, createdAt, lastSeenAt} EX 86400`.
- Cookie: `sid=<sid>; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`, plus `Secure` when `COOKIE_SECURE=true`.
- Role is copied into the session; role changes apply at next login (documented limitation).

---

## 12. Rate Limiting

### 12.1 Algorithm: sliding window counter
Two fixed-window counters (current and previous):

```text
weighted = prevCount × ((windowMs − elapsedInCurrentWindowMs) / windowMs) + currentCount
```

Avoids the boundary-burst problem of plain fixed windows with only two keys per subject.

### 12.2 `rateLimit.lua` (redis-coord)

```lua
-- KEYS[1] = rl:<rule>:<subject>:<currentWindowIndex>
-- KEYS[2] = rl:<rule>:<subject>:<previousWindowIndex>
-- ARGV[1] = limit, ARGV[2] = windowMs, ARGV[3] = elapsedMs in current window
local limit   = tonumber(ARGV[1])
local window  = tonumber(ARGV[2])
local elapsed = tonumber(ARGV[3])
local cur  = tonumber(redis.call('GET', KEYS[1]) or '0')
local prev = tonumber(redis.call('GET', KEYS[2]) or '0')
local weighted = prev * ((window - elapsed) / window) + cur
if weighted >= limit then
  return {0, 0, math.ceil(window - elapsed)}
end
redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], window * 2)
return {1, math.floor(limit - weighted - 1), 0}
```

`windowIndex = floor(Date.now() / windowMs)`.

### 12.3 Behaviour
- Allowed: `RateLimit-Limit` and `RateLimit-Remaining` headers.
- Blocked: 429 `RATE_LIMITED` with `Retry-After` in whole seconds (min 1).
- Subject: `user:<id>` when authenticated, else `ip:<ip>`. IP from `req.ip`; Express `trust proxy` comes from `TRUST_PROXY` (false locally, so `X-Forwarded-For` can't be spoofed).
- Implemented as a middleware factory: `rateLimit('holds')`.

---

## 13. Flights Module

### 13.1 Public reads
- `GET /api/airports` → cached `fs:airports`.
- `GET /api/flights?from=BOM&to=DEL&date=2026-10-05&sort=departure|price`
  - Validate IATA codes and ISO date; `from ≠ to`; date from today up to 90 days ahead.
  - Date is interpreted in the **source airport's timezone** and converted to a UTC `[start, end)` range.
  - Returns only `status = SCHEDULED` with `departure_time > now + 60 min`.
  - Items: `{flightId, flightNumber, from, to, departureTime, arrivalTime, durationMinutes, aircraftModel, fromPrice}` (`fromPrice = base_price`).
  - Cached at `fs:search:v<ver>:<from>:<to>:<date>:<sort>` via `getOrFill`, where `ver = GET fs:searchver` (missing = 0).
- `GET /api/flights/:flightId` → cached `fs:flight:<id>` via `getOrFill` with negative caching. DRAFT flights are 404 for non-admins.

### 13.2 Admin

| Method | Path | Behaviour |
|---|---|---|
| POST | `/api/admin/aircraft` | `{aircraftCode, model, layoutColumns, totalRows, businessRows}` → aircraft + generated seats in one transaction |
| GET | `/api/admin/aircraft` | List |
| POST | `/api/admin/flights` | `{flightNumber, aircraftId, from, to, departureTime, arrivalTime, basePrice}` → DRAFT |
| GET | `/api/admin/flights?status=&cursor=` | List |
| PATCH | `/api/admin/flights/:id` | DRAFT only, else 409 `FLIGHT_NOT_EDITABLE` |
| DELETE | `/api/admin/flights/:id` | DRAFT only |
| POST | `/api/admin/flights/:id/publish` | 13.3 |
| POST | `/api/admin/flights/:id/cancel` | SCHEDULED → CANCELLED; existing bookings untouched |

After every committed flight write: `DEL fs:flight:<id>` and `INCR fs:searchver`.

### 13.3 Publish (one transaction)
```text
withTransaction(tx):
  SELECT * FROM flights WHERE id = ? FOR UPDATE
  require status = DRAFT and departure_time > now, else 409 FLIGHT_NOT_EDITABLE
  load seats of the aircraft
  compute price per seat:
      price = base_price × (BUSINESS ? 2.5 : 1.0) + (WINDOW ? 350 : AISLE ? 250 : 0)
      rounded to 2 decimals
  booking.inventoryService.createInventory(tx, flightId, seats)   -- bulk INSERT flight_seats
  UPDATE flights SET status = 'SCHEDULED' WHERE id = ?
COMMIT
then invalidate caches (13.2)
```
Any failure rolls back everything: the flight stays DRAFT and no `flight_seats` exist. A flight is therefore never searchable without inventory.

### 13.4 Public service API (`modules/flights/index.ts`)
- `getBookability(flightId)` → reads the flight by primary key (no cache, always fresh) and returns `{bookable, reason: 'NOT_FOUND'|'NOT_SCHEDULED'|'CUTOFF'|null, snapshot}` where bookable = SCHEDULED and `departure_time − now > 60 min`.
- `getLayout(flightId)` → `{layoutColumns, totalRows}` from the flight's aircraft.

---

## 14. Caching and Cache-Stampede Protection

### 14.1 Pattern
Read-through (cache-aside) for reads; write-through for seat status after booking commits; delete/version bump for admin writes.

### 14.2 `getOrFill(key, ttlSeconds, loader)` (platform)

Two layers of coalescing:
1. **In-process singleflight**: a `Map<key, Promise>`. Concurrent requests for the same missing key share one promise.
2. **Distributed fill lock** in redis-coord: coalesces across multiple app instances (future-proof for horizontal scaling).

```text
getOrFill(key, ttl, loader):
  value = cache.GET(key)
  if hit: return (value == "__NF__") ? null : parse(value)

  return singleflight(key, async () => {
    token = uuid()
    if coord.SET("lock:fill:" + key, token, "PX", 5000, "NX") == OK:
      try:
        value = cache.GET(key)                       // double-check after acquiring
        if hit: return parse(value)
        data = await loader()                        // single DB query
        if data == null: cache.SET(key, "__NF__", "EX", jitter(30))
        else:            cache.SET(key, serialize(data), "EX", jitter(ttl))
        return data
      finally:
        compareAndDelete("lock:fill:" + key, token)  // releases only its own lock
    else:
      deadline = now + 2000ms
      while now < deadline:
        sleep(50 + random(0..25))
        value = cache.GET(key)
        if hit: return (value == "__NF__") ? null : parse(value)
      log CACHE_FILL_WAIT_TIMEOUT
      return await loader()                          // fallback: DB read, no cache write
  })

jitter(ttl) = round(ttl × (0.9 + random() × 0.2))
```

`compareAndDelete.lua`:
```lua
-- KEYS[1] = lock key, ARGV[1] = owner token
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
```

Degraded modes:
- redis-cache unreachable → call `loader()` directly (singleflight still applies), log `CACHE_UNAVAILABLE` (throttled).
- redis-coord unreachable → skip the distributed lock, singleflight only.

### 14.3 Seat status cache with version guard

Race being prevented: a fill reads the DB, a booking commits and sets the seat to `B` in the cache, then the slow fill overwrites the hash with the stale `A`.

Fix: `bs:seatsver:<flightId>` is bumped on every committed booking. A fill reads the version **before** querying the DB and writes only if it is unchanged. Both keys are in redis-cache so check-and-write is one atomic script.

`seatsFill.lua` (redis-cache):
```lua
-- KEYS[1] = bs:seats:<flightId>, KEYS[2] = bs:seatsver:<flightId>
-- ARGV[1] = expectedVersion, ARGV[2] = ttlSeconds, ARGV[3..] = seatId, status, seatId, status, ...
local current = redis.call('GET', KEYS[2]) or '0'
if current ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], unpack(ARGV, 3))
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return 1
```

`seatsMarkBooked.lua` (redis-cache), used after every commit and for cache repair:
```lua
-- KEYS[1] = bs:seats:<flightId>, KEYS[2] = bs:seatsver:<flightId>
-- ARGV = seatIds
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], 604800)
if redis.call('EXISTS', KEYS[1]) == 1 then
  for i = 1, #ARGV do redis.call('HSET', KEYS[1], ARGV[i], 'B') end
end
return 1
```
If the hash doesn't exist it is not created (a partial hash would look complete); the next read fills it from MySQL.

The seat status fill uses the same singleflight + fill lock (`lock:fill:bs:seats:<flightId>`) and writes through `seatsFill.lua`. If the script returns 0, the freshly loaded data is still returned to the caller; only the cache write is skipped (`CACHE_FILL_VERSION_SKIPPED`).

### 14.4 Invalidation summary

| Event | Action |
|---|---|
| Booking committed | `seatsMarkBooked.lua` for booked seats |
| Booking rejected because DB says seat BOOKED | `seatsMarkBooked.lua` for those seats (repair) |
| Flight created/edited/published/cancelled | `DEL fs:flight:<id>`, `INCR fs:searchver` |

---

## 15. Booking Module

In this module, **`seatId` always means `flight_seats.id`**.

### 15.1 Seat map — `GET /api/flights/:flightId/seats`
1. `meta = getOrFill("bs:seatmeta:<flightId>", 21600, load)` where `load` reads `flight_seats` for the flight plus `flights.getLayout(flightId)`. No rows → 404 `FLIGHT_NOT_FOUND`.
2. `status = getSeatStatus(flightId)` (hash `bs:seats:<flightId>`, version-guarded fill from `SELECT id, status FROM flight_seats WHERE flight_id = ?`).
3. `holds = HGETALL bs:holds:<flightId>` from redis-coord (expired fields are never returned).
4. Merge per seat, **in this order**:
   - `B` → `BOOKED`
   - held by the current user → `HELD_BY_YOU` with `holdExpiresAt`
   - held by someone else → `HELD` (shown as "temporarily unavailable")
   - otherwise → `AVAILABLE`
5. Include `serverTime` so the client can correct clock skew.

If redis-coord is down: return seats without hold information and `holdsUnavailable: true`.

### 15.2 Hold rules
- Holds are acquired when the user presses **Continue** on the seat map (not per click). The request contains the full desired seat set for that flight (**replace semantics**).
- 1–6 seats per flight; at most 2 flights with active holds per user.
- All-or-nothing: if any requested seat is held by someone else, nothing changes and the conflicting seats are returned.
- Seats the user already holds keep their original expiry (no extension). Seats the user held on this flight but did not include are released.
- Rejected if `flights.getBookability(flightId)` is not bookable.
- Seats marked `BOOKED` (seat status cache or DB) are rejected before running the script. A stale cache here is harmless; the booking transaction is the final check.
- Hourly quota: newly acquired seats per user per hour ≤ 40. Seats already held by the user don't count.

### 15.3 `PUT /api/flights/:flightId/holds`

Request: `{ "seatIds": [5012, 5013] }` (1–6 unique integers).

1. Validate; every `seatId` must belong to `flightId` (from seat metadata), else 400 `VALIDATION_ERROR`.
2. `getBookability` → not bookable → 409 `FLIGHT_NOT_BOOKABLE` (404 `FLIGHT_NOT_FOUND` if missing).
3. Any seat `BOOKED` → 409 `SEAT_UNAVAILABLE`, `details.seatIds`.
4. Quota: count requested seats not already held by the user; if `used + new > 40` → 429 `HOLD_QUOTA_EXCEEDED`.
5. Run `holdAcquire.lua`.
6. `OK` → `INCRBY bs:holdquota:<userId>:<hourIndex>` by newly added count, `EXPIRE 7200`; log `SEAT_HOLD_ACQUIRED`; respond 200 `{holds:[{seatId, seatNumber, expiresAt}], serverTime}` for this flight.
7. `CONFLICT` → 409 `SEAT_TEMPORARILY_UNAVAILABLE` with `details.seatIds`. `SEAT_LIMIT` / `FLIGHT_LIMIT` → 422 `HOLD_LIMIT_EXCEEDED` with `details.limit`.
8. redis-coord unavailable → 503 `SERVICE_DEGRADED`.

`holdAcquire.lua` (redis-coord, Redis 7.4+):
```lua
-- KEYS[1] = bs:holds:<flightId>
-- KEYS[2] = bs:userholds:<userId>
-- ARGV[1] = userId, ARGV[2] = flightId, ARGV[3] = ttlSeconds
-- ARGV[4] = maxSeatsPerFlight, ARGV[5] = maxFlights, ARGV[6..] = seatIds
local holdsKey, userKey = KEYS[1], KEYS[2]
local userId, flightId = ARGV[1], ARGV[2]
local ttl = tonumber(ARGV[3])
local maxSeats, maxFlights = tonumber(ARGV[4]), tonumber(ARGV[5])

local n = #ARGV - 5
if n < 1 or n > maxSeats then return {'SEAT_LIMIT'} end

local requested, conflicts, toAdd = {}, {}, {}
for i = 6, #ARGV do
  local seat = ARGV[i]
  requested[seat] = true
  local v = redis.call('HGET', holdsKey, seat)
  if v then
    if string.match(v, '^([^|]+)') ~= userId then conflicts[#conflicts + 1] = seat end
  else
    toAdd[#toAdd + 1] = seat
  end
end
if #conflicts > 0 then
  table.insert(conflicts, 1, 'CONFLICT')
  return conflicts
end

-- distinct flights the user currently holds seats on
local entries = redis.call('HKEYS', userKey)
local flights, flightCount = {}, 0
for _, f in ipairs(entries) do
  local fid = string.match(f, '^([^:]+):')
  if not flights[fid] then flights[fid] = true; flightCount = flightCount + 1 end
end
if not flights[flightId] and flightCount >= maxFlights then return {'FLIGHT_LIMIT'} end

-- replace semantics: release this user's seats on this flight that were not requested
for _, f in ipairs(entries) do
  local fid, seat = string.match(f, '^([^:]+):(.+)$')
  if fid == flightId and not requested[seat] then
    local v = redis.call('HGET', holdsKey, seat)
    if v and string.match(v, '^([^|]+)') == userId then redis.call('HDEL', holdsKey, seat) end
    redis.call('HDEL', userKey, f)
  end
end

-- use Redis server time, not app time
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local expiresAt = nowMs + ttl * 1000

for _, seat in ipairs(toAdd) do
  redis.call('HSET', holdsKey, seat, userId .. '|' .. expiresAt)
  redis.call('HEXPIRE', holdsKey, ttl, 'FIELDS', 1, seat)
  local uf = flightId .. ':' .. seat
  redis.call('HSET', userKey, uf, expiresAt)
  redis.call('HEXPIRE', userKey, ttl, 'FIELDS', 1, uf)
end
return {'OK', tostring(#toAdd)}
```

### 15.4 Releasing holds

`holdRelease.lua` (redis-coord):
```lua
-- KEYS[1] = bs:holds:<flightId>, KEYS[2] = bs:userholds:<userId>
-- ARGV[1] = userId, ARGV[2] = flightId, ARGV[3..] = seatIds (optional; none = all user's seats on flight)
local holdsKey, userKey = KEYS[1], KEYS[2]
local userId, flightId = ARGV[1], ARGV[2]
local seats = {}
if #ARGV > 2 then
  for i = 3, #ARGV do seats[#seats + 1] = ARGV[i] end
else
  for _, f in ipairs(redis.call('HKEYS', userKey)) do
    local fid, seat = string.match(f, '^([^:]+):(.+)$')
    if fid == flightId then seats[#seats + 1] = seat end
  end
end
local released = 0
for _, seat in ipairs(seats) do
  local v = redis.call('HGET', holdsKey, seat)
  if v and string.match(v, '^([^|]+)') == userId then
    redis.call('HDEL', holdsKey, seat)
    released = released + 1
  end
  redis.call('HDEL', userKey, flightId .. ':' .. seat)
end
return released
```
- `DELETE /api/flights/:flightId/holds` releases all the user's seats on that flight → 204.
- After a successful booking the same script releases exactly the booked seats.
- `GET /api/holds` returns the user's active holds across flights (from `bs:userholds:<userId>` + seat metadata) so checkout can resume after a refresh.

### 15.5 Booking creation — `POST /api/bookings`

Header `Idempotency-Key: <UUID v4>` is required (missing → 400 `IDEMPOTENCY_KEY_REQUIRED`; malformed → 400 `VALIDATION_ERROR`).

Body:
```json
{
  "flightId": 101,
  "seats": [
    { "seatId": 5012, "passenger": { "fullName": "Asha Rao", "age": 34 } },
    { "seatId": 5013, "passenger": { "fullName": "Ravi Rao", "age": 36 } }
  ],
  "payment": { "method": "UPI", "simulateOutcome": "SUCCESS" }
}
```
- 1–6 seats, unique seatIds; `fullName` 2–100 chars; `age` 0–120.
- `simulateOutcome`: `SUCCESS` (default) or `DECLINED`.
- The user is always `req.user.id`. Never accept a user ID from the body.

Three phases, so that **no DB lock is ever held during payment**.

**Phase A — Claim the idempotency key (autocommit insert)**
1. Compute `request_hash`.
2. `INSERT INTO bookings (booking_ref, user_id, flight_id, status, idempotency_key, request_hash, payment_method) VALUES (?, ?, ?, 'PENDING', ?, ?, ?)`.
3. Duplicate on `uq_user_idempotency` → load the row by `(user_id, idempotency_key)` and **replay**:
   - `request_hash` differs → 422 `IDEMPOTENCY_KEY_REUSED`.
   - `CONFIRMED` → 200 with the same booking body, header `Idempotent-Replayed: true`.
   - `FAILED` → the same error status/code as originally returned (from `failure_reason`), header `Idempotent-Replayed: true`.
   - `PENDING` younger than 120 s → 409 `BOOKING_IN_PROGRESS`, `Retry-After: 2`.
   - `PENDING` older than 120 s → `UPDATE bookings SET status='FAILED', failure_reason='BOOKING_ABANDONED' WHERE id=? AND status='PENDING'`, then replay as FAILED.
4. Duplicate on `uq_booking_ref` → regenerate and retry (max 5).

The unique index serializes concurrent duplicates: exactly one request claims the key, the rest replay.

**Phase B — Validate and pay (no DB locks held)**
5. Holds: `HMGET bs:holds:<flightId> <seatIds...>`; every seat must be held by this user. Otherwise `markFailed('HOLD_EXPIRED')` → 409. redis-coord unreachable → `markFailed('SERVICE_DEGRADED')` → 503.
6. `flights.getBookability(flightId)` → not bookable → `markFailed('FLIGHT_NOT_BOOKABLE')` → 409. Keep `snapshot` for step 9.
7. Prices: `SELECT id, seat_number, price FROM flight_seats WHERE flight_id=? AND id IN (...)` (plain read; prices are immutable after publish). Missing seats → `markFailed('VALIDATION_ERROR')` → 400. `total = sum(price)`. The client never sends prices.
8. Payment simulation (15.7). Declined → `markFailed('PAYMENT_DECLINED')` → 402. **Holds are kept** so the user can retry with a new key while the hold lasts.

**Phase C — Confirm transaction (short, locked)**
```sql
BEGIN;
SET SESSION innodb_lock_wait_timeout = 5;

SELECT id, status FROM flight_seats
 WHERE flight_id = ? AND id IN (?, ?, ...)
 ORDER BY id                                 -- consistent lock order prevents deadlocks
 FOR UPDATE;
-- any status <> 'AVAILABLE' → ROLLBACK, markFailed('SEAT_UNAVAILABLE'), cache repair, 409

UPDATE flight_seats
   SET status = 'BOOKED', booking_id = ?
 WHERE id IN (?, ...) AND status = 'AVAILABLE';
-- affectedRows must equal seat count, else ROLLBACK → SEAT_UNAVAILABLE

INSERT INTO booking_seats (booking_id, flight_seat_id, seat_number, price, passenger_name, passenger_age)
VALUES (...), (...);

UPDATE bookings
   SET status = 'CONFIRMED', total_amount = ?, payment_ref = ?, flight_snapshot = ?, confirmed_at = NOW(3)
 WHERE id = ? AND status = 'PENDING';
-- affectedRows must be 1, else ROLLBACK → 409 BOOKING_ABANDONED

COMMIT;
```
- Deadlock (1213) or lock-wait timeout (1205): retry all of Phase C up to 3 times (25/50/100 ms + jitter), log `BOOKING_TX_RETRY`. After the last failure → `markFailed('SERVICE_UNAVAILABLE')` → 503.
- Any other error: ROLLBACK, `markFailed('INTERNAL_ERROR')` → 500. A success response is never sent unless COMMIT succeeded.
- Reset the session `innodb_lock_wait_timeout` (or use a dedicated connection released after the transaction) so pooled connections don't keep the setting.

**Post-commit (best effort; never changes the response)**
9. `seatsMarkBooked.lua` for the booked seats.
10. `holdRelease.lua` for the booked seats.
11. Log `BOOKING_SUCCESS`. If 9 or 10 fails, log `POST_COMMIT_CACHE_UPDATE_FAILED`. Staleness is bounded by seat-status TTL and hold TTL (10 min each); MySQL stays authoritative, and the seat map shows BOOKED before HELD anyway.
12. Respond 201 with the booking.

`markFailed(reason)`:
```sql
UPDATE bookings SET status = 'FAILED', failure_reason = ? WHERE id = ? AND status = 'PENDING';
```

### 15.6 Booking response
```json
{
  "bookingRef": "K7XQ2M",
  "status": "CONFIRMED",
  "flight": {
    "flightId": 101, "flightNumber": "AI-101", "from": "BOM", "to": "DEL",
    "departureTime": "2026-10-05T03:30:00.000Z", "arrivalTime": "2026-10-05T05:40:00.000Z"
  },
  "seats": [
    { "seatId": 5012, "seatNumber": "12A", "price": "5849.00", "passenger": { "fullName": "Asha Rao", "age": 34 } }
  ],
  "totalAmount": "11448.00",
  "currency": "INR",
  "payment": { "method": "UPI", "reference": "SIMPAY-8F2K1Q9Z" },
  "confirmedAt": "2026-09-28T10:15:22.481Z"
}
```

### 15.7 Payment simulator
- `payment.simulator.ts` inside the booking module.
- Waits 300–800 ms, returns `{approved: simulateOutcome !== 'DECLINED', reference: 'SIMPAY-' + 8 random chars}`.
- Runs at most once per idempotency key, because replays return before Phase B.
- Code comment: with a real provider, the idempotency key would be forwarded to the provider and a failure after capture would need a refund step.

### 15.8 Booking history
- `GET /api/bookings?status=CONFIRMED|FAILED|ALL&cursor=<id>&limit=20` — default `CONFIRMED`, newest first, `{items, nextCursor}`. PENDING is never listed.
- `GET /api/bookings/:bookingRef` — owner or ADMIN; otherwise 404 (not 403, to avoid leaking existence).

### 15.9 Admin inventory
- `GET /api/admin/inventory/flights/:flightId` → `{seatCount, booked, available, heldNow}`.

### 15.10 Public service API (`modules/booking/index.ts`)
- `inventoryService.createInventory(tx, flightId, seats[])` — bulk insert `flight_seats` using the caller's transaction. Used only by flights publish.

---

## 16. Public API Reference

JSON everywhere. Timestamps ISO-8601 UTC. Money as strings.

| Method | Path | Request | Success |
|---|---|---|---|
| POST | `/api/auth/register` | `{name, email, password}` | 201 `{user}` + cookie |
| POST | `/api/auth/login` | `{email, password}` | 200 `{user}` + cookie |
| POST | `/api/auth/logout` | — | 204 |
| GET | `/api/auth/me` | — | 200 `{user}` |
| GET | `/api/airports` | — | 200 `{airports}` |
| GET | `/api/flights` | `?from&to&date&sort` | 200 `{flights}` |
| GET | `/api/flights/:flightId` | — | 200 `{flight}` |
| GET | `/api/flights/:flightId/seats` | — | 200 seat map |
| PUT | `/api/flights/:flightId/holds` | `{seatIds}` | 200 `{holds, serverTime}` |
| DELETE | `/api/flights/:flightId/holds` | — | 204 |
| GET | `/api/holds` | — | 200 `{holds, serverTime}` |
| POST | `/api/bookings` | 15.5 + `Idempotency-Key` | 201 booking (200 on replay) |
| GET | `/api/bookings` | `?status&cursor&limit` | 200 `{items, nextCursor}` |
| GET | `/api/bookings/:bookingRef` | — | 200 booking |
| * | `/api/admin/...` | 13.2, 15.9 | — |

`user` = `{id, name, email, role}`. Never return `password_hash`.

Seat map example:
```json
{
  "flightId": 101,
  "serverTime": "2026-09-28T10:10:00.000Z",
  "layout": { "rows": 30, "columns": ["A", "B", "C", null, "D", "E", "F"] },
  "holdsUnavailable": false,
  "seats": [
    { "seatId": 5012, "seatNumber": "12A", "row": 12, "column": "A",
      "cabinClass": "ECONOMY", "seatType": "WINDOW", "price": "5849.00",
      "status": "HELD_BY_YOU", "holdExpiresAt": "2026-09-28T10:19:41.000Z" }
  ]
}
```

---

## 17. Error Model

```json
{ "error": { "code": "SEAT_TEMPORARILY_UNAVAILABLE", "message": "Some seats are being held by another traveller.", "details": { "seatIds": [5013] } }, "requestId": "..." }
```

| Code | HTTP | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Invalid body/query/params |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Missing header on POST /api/bookings |
| `UNAUTHENTICATED` | 401 | No/invalid session |
| `INVALID_CREDENTIALS` | 401 | Wrong email or password |
| `FORBIDDEN` | 403 | Not admin, or origin check failed |
| `NOT_FOUND` / `FLIGHT_NOT_FOUND` / `BOOKING_NOT_FOUND` | 404 | |
| `EMAIL_TAKEN` | 409 | |
| `SEAT_UNAVAILABLE` | 409 | Seat already booked |
| `SEAT_TEMPORARILY_UNAVAILABLE` | 409 | Seat held by another user |
| `HOLD_EXPIRED` | 409 | Paying without a valid hold |
| `FLIGHT_NOT_BOOKABLE` | 409 | Not SCHEDULED or within cutoff |
| `FLIGHT_NOT_EDITABLE` | 409 | Admin change on a non-DRAFT flight |
| `BOOKING_IN_PROGRESS` | 409 | Duplicate while first is PENDING |
| `BOOKING_ABANDONED` | 409 | PENDING booking went stale |
| `PAYMENT_DECLINED` | 402 | Simulated decline |
| `HOLD_LIMIT_EXCEEDED` | 422 | > 6 seats or > 2 flights |
| `IDEMPOTENCY_KEY_REUSED` | 422 | Same key, different body |
| `RATE_LIMITED` | 429 | |
| `HOLD_QUOTA_EXCEEDED` | 429 | > 40 new seat holds per hour |
| `ACCOUNT_TEMPORARILY_LOCKED` | 429 | Too many failed logins |
| `INTERNAL_ERROR` | 500 | Unexpected; no stack traces in responses |
| `SERVICE_UNAVAILABLE` | 503 | DB unavailable, retries exhausted |
| `SERVICE_DEGRADED` | 503 | redis-coord unavailable for a feature that needs it |

`429` and `409 BOOKING_IN_PROGRESS` always include `Retry-After`.

---

## 18. Frontend (React SPA)

### 18.1 Setup
- React 19 + Vite + TypeScript, React Router, TanStack Query, Tailwind CSS.
- Vite dev proxy: `/api` → `http://localhost:8080`. The browser only talks to its own origin; there is no CORS configuration anywhere.
- `apps/web/src/api/client.ts`: JSON `fetch` wrapper with `credentials: 'same-origin'`; parses the error model into `ApiError {status, code, message, details, retryAfter}`.
- DTO schemas and error codes imported from `packages/shared`.

### 18.2 Pages

| Route | Page | Auth |
|---|---|---|
| `/` | Search form (from, to, date) | public |
| `/flights?from&to&date` | Results, sort by departure/price | public |
| `/flights/:flightId/seats` | Seat map, selection, Continue | public to view, login to hold |
| `/checkout/:flightId` | Countdown, passenger forms, payment method, Pay | session |
| `/bookings/:bookingRef` | Confirmation / ticket | session |
| `/bookings` | History (infinite scroll) | session |
| `/login`, `/register` | Auth forms (redirect back after login) | public |
| `/admin/aircraft`, `/admin/flights` | Admin CRUD, publish, cancel | admin |

### 18.3 Seat map
- Poll every 5 s (`refetchInterval`), paused when the tab is hidden.
- States: AVAILABLE (selectable), SELECTED (local), HELD_BY_YOU, HELD ("temporarily unavailable", styled as unavailable, not as an error), BOOKED (disabled). Show cabin class and price.
- Local selection max 6. **Continue** → `PUT /holds`:
  - 409 `SEAT_TEMPORARILY_UNAVAILABLE` / `SEAT_UNAVAILABLE`: highlight `details.seatIds`, drop them from the selection, refetch, show a message.
  - 422 `HOLD_LIMIT_EXCEEDED`: show the limit.
  - 200: go to checkout.
- "Change seats" on checkout returns here; the next Continue replaces the hold set.

### 18.4 Checkout
- On mount `GET /api/holds`; no holds for this flight → redirect to the seat map.
- Countdown: `clockOffset = serverTime − Date.now()`; remaining = `min(holdExpiresAt) − (Date.now() + clockOffset)`. At 0: disable Pay and show "Your seat hold has expired. Please select seats again."
- The countdown is UX only; the server re-checks holds on Pay.
- **Idempotency key**: `crypto.randomUUID()` on the first Pay click of an attempt, stored in `sessionStorage` under `checkout:<flightId>` with the request body. Reused for retries and after refresh. Cleared on CONFIRMED or any terminal FAILED (e.g. PAYMENT_DECLINED), so the next attempt gets a fresh key.
- Network error/timeout: retry up to 3 times (1 s, 2 s, 4 s) with the same key. On 409 `BOOKING_IN_PROGRESS`: wait `Retry-After`, retry with the same key.
- Pay disabled while a request is in flight.
- Dev-only "Simulate payment failure" toggle → `simulateOutcome: 'DECLINED'`.

### 18.5 Global
- 401 → `/login?next=<current>`. 429 → toast with seconds from `Retry-After`. 503 → "Service temporarily unavailable".
- Times shown in the airport's local timezone with its abbreviation.

---

## 19. Observability

### 19.1 Logging
- pino JSON to stdout. Base fields: `level`, `time`, `requestId`, `module`, and when present `userId`, `flightId`, `bookingRef`.
- One request log per request: method, route pattern, status, duration.
- Never log passwords, session IDs, cookies, or auth request bodies. Hash IPs/emails if logged.

### 19.2 Event names
```text
AUTH_REGISTER, AUTH_LOGIN_SUCCESS, AUTH_LOGIN_FAILED, AUTH_ACCOUNT_LOCKED, AUTH_LOGOUT
RATE_LIMITED, RATE_LIMIT_BYPASSED
CACHE_HIT / CACHE_MISS (debug), CACHE_FILL, CACHE_FILL_WAIT_TIMEOUT, CACHE_FILL_VERSION_SKIPPED, CACHE_UNAVAILABLE
SEAT_HOLD_ACQUIRED, SEAT_HOLD_CONFLICT, SEAT_HOLD_LIMIT, SEAT_HOLD_RELEASED
BOOKING_CLAIMED, BOOKING_IDEMPOTENT_REPLAY, BOOKING_IN_PROGRESS
PAYMENT_APPROVED, PAYMENT_DECLINED
BOOKING_TX_RETRY, BOOKING_SUCCESS, BOOKING_FAILED, POST_COMMIT_CACHE_UPDATE_FAILED
FLIGHT_PUBLISHED, FLIGHT_CANCELLED
SHUTDOWN_STARTED, SHUTDOWN_COMPLETE
```

### 19.3 Health
- `GET /health` → 200 while the process runs.
- `GET /ready` → 200 only if MySQL (`SELECT 1`), redis-cache and redis-coord (`PING`) answer within 1 s; otherwise 503 with per-dependency status. Used by the Docker healthcheck.

### 19.4 Test-mode counters
Only when `NODE_ENV=test`: `GET /api/_test/stats` returns counters (`dbQueries.flightById`, `dbQueries.seatStatus`, `paymentCalls`) and `POST /api/_test/reset` resets them. Never registered in other environments. Used by stampede and idempotency tests. Fault-injection hooks for tests (e.g. throw after the seat UPDATE in Phase C) are also test-only.

### 19.5 Graceful shutdown
On `SIGTERM`/`SIGINT`: log `SHUTDOWN_STARTED`, `/ready` → 503, stop accepting connections, wait for in-flight requests up to 10 s, close the MySQL pool and Redis clients, exit 0 (exit 1 on timeout).

---

## 20. Failure Scenarios

| Scenario | Behaviour |
|---|---|
| User abandons checkout | Hold fields expire via `HEXPIRE`; seat shows AVAILABLE on the next poll. |
| Pay after hold expiry | Phase B step 5 → FAILED `HOLD_EXPIRED`, 409. |
| Two users Continue on the same seat | Atomic Lua script: one gets the hold, the other `SEAT_TEMPORARILY_UNAVAILABLE`. |
| Hold expires during payment, another user holds and books the seat | Phase C row lock: first commit wins; the other sees BOOKED → FAILED `SEAT_UNAVAILABLE`. Never two bookings (row lock + `uq_booked_seat`). |
| Duplicate POST (retry, double click) | Unique `(user_id, idempotency_key)` claim → replay or `BOOKING_IN_PROGRESS`. Payment runs once. |
| Same key, different body | 422 `IDEMPOTENCY_KEY_REUSED`. |
| App crashes after claim, before commit | Booking stays PENDING; after 120 s the next replay marks it `BOOKING_ABANDONED`. Seats never changed. Holds expire via TTL. |
| App crashes during Phase C | InnoDB rolls back; no partial booking. |
| App crashes after COMMIT, before cache update | DB correct. Cache may show AVAILABLE ≤ 10 min; any hold/booking attempt fails in Phase C and repairs the cache. Hold expires via TTL. |
| Deadlock / lock-wait timeout | Phase C retried up to 3 times; ordered locking makes deadlocks rare. |
| Publish fails midway | Whole transaction rolls back; flight stays DRAFT with no inventory. |
| redis-cache down | Reads go to MySQL (singleflight limits duplicates). Everything else works. |
| redis-coord down | Logged-in routes 503; holds/bookings 503 `SERVICE_DEGRADED`; public search and seat map (without hold info) work; rate limiter fails open. Bookings are refused, never performed without coordination. |
| MySQL down | Cached reads work until TTL; writes 503; `/ready` fails. |
| Fill-lock holder crashes | Lock expires in 5 s; waiters time out at 2 s and read DB directly. |
| Stale fill racing a booking | Version guard skips the stale write. |
| Flight cancelled while users hold seats | `getBookability` reads the DB directly, so the next hold/booking immediately gets `FLIGHT_NOT_BOOKABLE`. |

---

## 21. Security Checklist

- [ ] bcrypt cost 12; dummy-hash comparison for unknown emails.
- [ ] Session IDs: 32 random bytes; stored in Redis only as SHA-256; rotated on login; deleted on logout.
- [ ] Cookie: `HttpOnly`, `SameSite=Lax`, `Secure` in production.
- [ ] CSRF: same-origin deployment + Origin check on mutating requests.
- [ ] All input validated with zod; parameterized queries only.
- [ ] User identity always from the session, never from request bodies.
- [ ] Admin routes require role ADMIN.
- [ ] Booking details: owner or admin only, 404 otherwise.
- [ ] Prices always computed server-side.
- [ ] Rate limits, login lockout, hold limits and hourly quota enforced.
- [ ] Test-only routes and fault hooks never registered outside `NODE_ENV=test`.
- [ ] No stack traces or internal messages in responses.
- [ ] Secrets only via env; `.env` git-ignored.

---

## 22. Seed Data

`npm run seed`: deterministic (fixed PRNG seed), idempotent (skips existing records), runs through module services so business rules apply.

- **Users:** admin from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`; demo users `user1@example.com` … `user5@example.com`, password `password123` (dev only).
- **Airports (12, `Asia/Kolkata`):** BOM, DEL, BLR, HYD, MAA, CCU, GOI, PNQ, AMD, COK, JAI, LKO.
- **Aircraft (8):**

  | Model | Layout | Rows | Business rows | Seats |
  |---|---|---|---|---|
  | A320neo (×3) | `ABC-DEF` | 30 | 2 | 180 |
  | A321neo (×2) | `ABC-DEF` | 37 | 2 | 222 |
  | B737-800 (×2) | `ABC-DEF` | 31 | 2 | 186 |
  | ATR 72 (×1) | `AC-DF` | 18 | 0 | 72 |

- **Flights:** ~20 routes, prefixes `AI`, `6E`, `QP`, `SG`, `IX`, 1–3 per route per day for the next 14 days (~450 flights), durations 1 h 5 m–3 h, base prices ₹3,000–₹9,000. ATR 72 only on short routes (e.g. BOM–GOI, BOM–PNQ). Created as DRAFT, then published through the real publish logic.
- ~5 % of seats on the next 3 days' flights are booked by demo users through the real booking service code, so seat maps look realistic.

---

## 23. Testing Plan

### 23.1 Levels
- **Unit (vitest):** pricing, layout generation, request-hash canonicalization, error mapping, sliding-window math, `getOrFill` with fakes.
- **Lua tests:** each script against real Redis 7.4 (docker) with edge cases.
- **Integration (vitest + supertest):** full app against the compose stack with `NODE_ENV=test`, `HOLD_TTL_SECONDS=3`, database `flight_booking_test`, Redis flushed between suites.
- **Concurrency:** `Promise.all` bursts or autocannon scripts in `tests/load`.

### 23.2 Must-pass scenarios

| # | Scenario | Expected |
|---|---|---|
| 1 | 50 users `PUT /holds` the same seat at once | Exactly 1 × 200, 49 × 409 `SEAT_TEMPORARILY_UNAVAILABLE` |
| 2 | 20 parallel Phase C runs for the same seat (test helper bypassing holds) | Exactly 1 CONFIRMED; 1 `booking_seats` row; others FAILED `SEAT_UNAVAILABLE` |
| 3 | Same user + same `Idempotency-Key`, 10 parallel POSTs | 1 booking row; `paymentCalls == 1`; responses are the same `bookingRef` or 409 `BOOKING_IN_PROGRESS`; retry after `Retry-After` returns the same `bookingRef` |
| 4 | Same key, different body | 422 `IDEMPOTENCY_KEY_REUSED` |
| 5 | Hold, wait > TTL, another user holds | Succeeds |
| 6 | Hold, wait > TTL, holder pays | 409 `HOLD_EXPIRED`; booking FAILED; replay returns 409 again |
| 7 | B holds 12B; A requests 12A, 12B, 12C | A gets 409 with 12B's id; A holds nothing |
| 8 | 7 seats; or a 3rd flight | 422 `HOLD_LIMIT_EXCEEDED` |
| 9 | Re-PUT the same seats 2 s later | `expiresAt` unchanged |
| 10 | Hold {A,B}, then PUT {B,C} | Holds = {B,C}; A available; B keeps its original expiry |
| 11 | Flush cache; 200 concurrent `GET /api/flights/:id` | `dbQueries.flightById == 1` |
| 12 | Flush cache; 200 concurrent seat-map GETs | `dbQueries.seatStatus == 1` |
| 13 | Slow seat fill (injected delay) with a booking commit in between | Cache shows `B` for the booked seat afterwards |
| 14 | 11 logins from one IP in a minute | 11th → 429 with `Retry-After` |
| 15 | 10 failed logins for one account | Locked 15 min even with the right password (429) |
| 16 | Fault: throw after the seat UPDATE in Phase C | Seat AVAILABLE; booking FAILED `INTERNAL_ERROR`; 500 |
| 17 | Fault: stop after the claim; replay after the stale threshold (test override) | FAILED `BOOKING_ABANDONED`; seat AVAILABLE |
| 18 | Stop redis-coord | Search works; holds/bookings 503 `SERVICE_DEGRADED`; no booking created |
| 19 | Stop redis-cache | Everything works via MySQL |
| 20 | Two multi-seat Phase C runs with overlapping seats in opposite request order | No deadlock error surfaces; exactly one succeeds |
| 21 | Payment declined, then retry with a new key while hold is valid | Second attempt succeeds |
| 22 | Fault during publish after inventory insert | Flight still DRAFT; zero `flight_seats` rows for it |
| 23 | Cancel a flight, then try to hold/book it | 409 `FLIGHT_NOT_BOOKABLE` immediately |
| 24 | POST from a foreign `Origin` | 403 `FORBIDDEN` |
| 25 | ESLint boundary rule | Importing another module's internals fails lint |

---

## 24. Implementation Phases

Each phase must pass its acceptance criteria and tests before the next starts. Small commits per phase.

| Phase | Deliverables | Acceptance criteria |
|---|---|---|
| **0. Scaffolding** | Workspaces, TS/ESLint (incl. boundary rule), `packages/shared`, platform (config, logger, errors, db, redis), docker-compose, MySQL init | `docker compose up` healthy; `/ready` 200; build and lint pass; test 25 |
| **1. Auth** | users schema, register/login/logout/me, sessions, pipeline middleware (request ID, origin check, session, route auth) | Register/login works; cookie set; test 24 |
| **2. Flights catalog** | Schemas, airports, aircraft + seat generation, admin flight CRUD, search, details (no cache yet) | Admin can create aircraft/flights; search returns SCHEDULED only |
| **3. Inventory + publish** | Booking schemas, `createInventory`, publish transaction, seat map from DB, seed | Seeded flights searchable with seat maps; test 22 |
| **4. Booking core (no holds yet)** | Claim → payment sim → Phase C → replay, history | Tests 2, 3, 4, 16, 17, 20 |
| **5. Caching** | `getOrFill`, singleflight, fill lock, negative cache, jitter, search versioning, seat status cache + version guard, post-commit update | Tests 11, 12, 13, 19 |
| **6. Holds** | Lua scripts, PUT/DELETE/GET holds, limits, quota, booking requires holds | Tests 1, 5–10, 18, 21, 23 |
| **7. Rate limiting** | Sliding window limiter, route rules, login lockout | Tests 14, 15 |
| **8. Frontend** | All pages, countdown, idempotent pay with retries | Full manual flow works; hold expiry UX correct |
| **9. Hardening** | Degraded Redis modes, readiness, graceful shutdown, log review | All 25 tests green |
| **10. Admin UI + polish** | Admin pages, README (setup, architecture summary, running tests), app-mode compose | Fresh clone → `docker compose --profile app up` → working app |

---

## 25. Future Scaling (Do Not Implement)

Talking points only:
- Run several API instances behind a load balancer; the app is stateless (sessions, holds, locks, rate limits are in Redis), and the distributed fill lock already coalesces across instances.
- Extract the booking module into its own service: its tables and public API are already isolated; drop the cross-module FKs and replace the three cross-module function calls with HTTP calls.
- Redis Cluster: use hash tags (e.g. `bs:holds:{f101}`) so hold scripts stay single-slot.
- MySQL read replicas for search and history.
- Transactional outbox + message broker for notifications or cancellations with refunds.
- Server-Sent Events for live seat maps instead of polling.
- Partition `flight_seats` / `bookings` by flight date at very large scale.

---

## 26. System Invariants

These must hold in every scenario; tests exist to prove them.

1. A flight seat has at most one CONFIRMED booking (row lock + `uq_booked_seat`).
2. A booking is CONFIRMED only if its transaction committed; success is never returned otherwise.
3. Multi-seat bookings and multi-seat holds are all-or-nothing.
4. A user can only confirm seats they currently hold, checked on the server at payment time.
5. Holds expire automatically after 10 minutes and are never extended.
6. The same `(user, Idempotency-Key)` yields at most one booking and at most one payment; a different body with the same key is rejected.
7. Redis never marks a seat BOOKED before MySQL commits.
8. Losing any redis-cache key affects performance only, never correctness.
9. When redis-coord is unavailable, holds and bookings are refused rather than performed without coordination.
10. No DB lock is held while waiting on payment.
11. A flight is SCHEDULED only if its inventory exists (same transaction).
12. Modules never query another module's tables; they use the public service APIs in Section 3.3.
13. User identity always comes from the server-side session.
