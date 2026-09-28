import { CACHE_TTL_SECONDS, type CabinClass, type SeatType } from '@flight/shared';
import { getOrFill } from '../../platform/cache/getOrFill.js';
import { jitter } from '../../platform/cache/jitter.js';
import { fillWithRedis } from '../../platform/cache/redisFill.js';
import { db } from '../../platform/db.js';
import { moduleLogger } from '../../platform/logger.js';
import { cacheRedis } from '../../platform/redis.js';
import { runTestHook } from '../../platform/testSupport.js';
import { flightsService } from '../flights/index.js';
import { flightSeatsRepository } from './flightSeats.repository.js';

const log = moduleLogger('booking');

export interface SeatMeta {
  seatId: number;
  seatNumber: string;
  row: number;
  column: string;
  cabinClass: CabinClass;
  seatType: SeatType;
  price: string;
}

/** Layout + seat metadata + prices: immutable after publish. */
export interface SeatMapMeta {
  layout: { rows: number; columns: Array<string | null> };
  seats: SeatMeta[];
}

/** `A` = available, `B` = booked. */
export type SeatStatusMap = Map<number, 'A' | 'B'>;

/** Keys owned by the booking module (`bs:` prefix, Section 9.2), all in redis-cache. */
const metaKey = (flightId: number): string => `bs:seatmeta:${flightId}`;
const statusKey = (flightId: number): string => `bs:seats:${flightId}`;
const versionKey = (flightId: number): string => `bs:seatsver:${flightId}`;

/** Reads `flight_seats` for the flight plus the aircraft layout. Null when the flight has no inventory. */
async function loadSeatMeta(flightId: number): Promise<SeatMapMeta | null> {
  const rows = await flightSeatsRepository.listByFlight(db, flightId);
  if (rows.length === 0) return null;
  const layout = await flightsService.getLayout(flightId);
  if (layout === null) return null;
  return {
    layout: { rows: layout.totalRows, columns: layout.columns },
    seats: rows.map((row) => ({
      seatId: row.id,
      seatNumber: row.seatNumber,
      row: row.rowNo,
      column: row.columnCode,
      cabinClass: row.cabinClass,
      seatType: row.seatType,
      price: row.price
    }))
  };
}

/**
 * Seat status hash `bs:seats:<flightId>` (600 s) with a version-guarded fill (Section 14.3).
 *
 * The race being prevented: a fill reads the DB, a booking commits and marks the seat `B` in the
 * cache, then the slow fill overwrites the hash with the stale `A`. Fix: `bs:seatsver:<flightId>` is
 * bumped by every committed booking; a fill reads that version BEFORE querying the database and
 * `seatsFill.lua` writes only if it is unchanged. Both keys live in redis-cache, so the check-and-write
 * is one atomic script. A skipped write still returns the freshly loaded data to the caller.
 */
function fillSeatStatus(flightId: number): Promise<SeatStatusMap> {
  let version: string | undefined;
  return fillWithRedis<SeatStatusMap>({
    lockKey: `lock:fill:${statusKey(flightId)}`,
    readCached: async () => {
      const hash = await cacheRedis.hgetall(statusKey(flightId));
      const entries = Object.entries(hash);
      if (entries.length === 0) return undefined;
      const map: SeatStatusMap = new Map();
      for (const [seatId, value] of entries) {
        if (value !== 'A' && value !== 'B') {
          await cacheRedis.del(statusKey(flightId)); // corrupt entry: drop it and treat as a miss
          return undefined;
        }
        map.set(Number(seatId), value);
      }
      return map;
    },
    load: async () => {
      try {
        version = (await cacheRedis.get(versionKey(flightId))) ?? '0';
      } catch {
        version = undefined; // cache unreachable: still serve from the database, just don't write
      }
      const rows = await flightSeatsRepository.listStatuses(db, flightId);
      await runTestHook('seatFillAfterDbRead');
      return new Map(rows.map((row) => [row.id, row.status === 'BOOKED' ? ('B' as const) : ('A' as const)]));
    },
    write: async (map) => {
      if (version === undefined || map.size === 0) return;
      const pairs = [...map.entries()].flatMap(([seatId, status]) => [String(seatId), status]);
      const written = await cacheRedis.seatsFill(
        statusKey(flightId),
        versionKey(flightId),
        version,
        jitter(CACHE_TTL_SECONDS.seatStatus),
        ...pairs
      );
      if (written === 0) log.info({ event: 'CACHE_FILL_VERSION_SKIPPED', flightId }, 'CACHE_FILL_VERSION_SKIPPED');
    }
  });
}

/** Seat metadata and status readers used by the seat map and the hold service. */
export const seatCache = {
  /** `bs:seatmeta:<flightId>` for 6 h; null (negatively cached) when the flight has no inventory. */
  getSeatMeta(flightId: number): Promise<SeatMapMeta | null> {
    return getOrFill(metaKey(flightId), CACHE_TTL_SECONDS.seatMeta, () => loadSeatMeta(flightId));
  },

  getSeatStatus: fillSeatStatus,

  /**
   * Marks seats booked in the status hash and bumps the version (`seatsMarkBooked.lua`). Called after
   * every commit, and to repair the cache when a booking is rejected because MySQL says a seat is
   * BOOKED. Never creates a partial hash: if the hash is absent the next read fills it from MySQL.
   */
  async markBooked(flightId: number, seatIds: number[]): Promise<void> {
    if (seatIds.length === 0) return;
    await cacheRedis.seatsMarkBooked(statusKey(flightId), versionKey(flightId), ...seatIds.map(String));
  }
};
