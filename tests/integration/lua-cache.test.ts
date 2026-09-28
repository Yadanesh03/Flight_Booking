import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cacheRedis, coordRedis } from '../../apps/api/src/platform/redis.js';
import { resetState, startTestApp, stopTestApp } from './helpers/testApp.js';

/**
 * Lua scripts against a real Redis (Section 23.1): compareAndDelete (redis-coord) and the two seat
 * status scripts (redis-cache).
 */
beforeAll(async () => {
  await startTestApp();
});
afterAll(stopTestApp);
beforeEach(resetState);

describe('compareAndDelete.lua', () => {
  it('deletes the key only when the token matches', async () => {
    await coordRedis.set('lock:fill:x', 'token-A', 'PX', 5000);
    expect(await coordRedis.compareAndDelete('lock:fill:x', 'token-B')).toBe(0);
    expect(await coordRedis.get('lock:fill:x')).toBe('token-A');
    expect(await coordRedis.compareAndDelete('lock:fill:x', 'token-A')).toBe(1);
    expect(await coordRedis.exists('lock:fill:x')).toBe(0);
  });

  it('returns 0 for a missing key', async () => {
    expect(await coordRedis.compareAndDelete('lock:fill:missing', 'anything')).toBe(0);
  });

  it('a late release of an expired lock cannot delete the lock its successor now holds', async () => {
    await coordRedis.set('lock:fill:y', 'owner-1', 'PX', 5000);
    expect(await coordRedis.compareAndDelete('lock:fill:y', 'owner-1')).toBe(1);
    await coordRedis.set('lock:fill:y', 'owner-2', 'PX', 5000, 'NX'); // successor acquires
    expect(await coordRedis.compareAndDelete('lock:fill:y', 'owner-1')).toBe(0); // stale release: no-op
    expect(await coordRedis.get('lock:fill:y')).toBe('owner-2');
  });
});

const STATUS = 'bs:seats:9';
const VERSION = 'bs:seatsver:9';

describe('seatsFill.lua', () => {
  it('writes the whole hash with a TTL when the version is unchanged (missing version counts as 0)', async () => {
    expect(await cacheRedis.seatsFill(STATUS, VERSION, '0', 600, '1', 'A', '2', 'B', '3', 'A')).toBe(1);
    expect(await cacheRedis.hgetall(STATUS)).toEqual({ '1': 'A', '2': 'B', '3': 'A' });
    const ttl = await cacheRedis.ttl(STATUS);
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it('matches an existing version counter', async () => {
    await cacheRedis.set(VERSION, '7');
    expect(await cacheRedis.seatsFill(STATUS, VERSION, '7', 600, '1', 'A')).toBe(1);
    expect(await cacheRedis.hgetall(STATUS)).toEqual({ '1': 'A' });
  });

  it('replaces the previous contents entirely (no stale fields survive)', async () => {
    await cacheRedis.hset(STATUS, { '1': 'A', '99': 'B' });
    expect(await cacheRedis.seatsFill(STATUS, VERSION, '0', 600, '1', 'B', '2', 'A')).toBe(1);
    expect(await cacheRedis.hgetall(STATUS)).toEqual({ '1': 'B', '2': 'A' });
  });

  it('refuses the write when the version changed since the fill began, leaving the cache untouched', async () => {
    await cacheRedis.set(VERSION, '3');
    expect(await cacheRedis.seatsFill(STATUS, VERSION, '2', 600, '1', 'A')).toBe(0);
    expect(await cacheRedis.exists(STATUS)).toBe(0); // no partial/stale hash was created

    await cacheRedis.hset(STATUS, { '1': 'B' });
    expect(await cacheRedis.seatsFill(STATUS, VERSION, '2', 600, '1', 'A', '2', 'A')).toBe(0);
    expect(await cacheRedis.hgetall(STATUS)).toEqual({ '1': 'B' }); // existing entry untouched
  });

  it('refuses expected version 0 when a counter already exists', async () => {
    await cacheRedis.set(VERSION, '1');
    expect(await cacheRedis.seatsFill(STATUS, VERSION, '0', 600, '1', 'A')).toBe(0);
  });

  it('handles a very large aircraft (chunked HSET beyond the Lua unpack limit)', async () => {
    const seats = 5000;
    const pairs: string[] = [];
    for (let i = 1; i <= seats; i += 1) pairs.push(String(i), i % 7 === 0 ? 'B' : 'A');
    expect(await cacheRedis.seatsFill(STATUS, VERSION, '0', 600, ...pairs)).toBe(1);
    expect(await cacheRedis.hlen(STATUS)).toBe(seats);
    expect(await cacheRedis.hget(STATUS, '7')).toBe('B');
    expect(await cacheRedis.hget(STATUS, '5000')).toBe('A');
    expect(await cacheRedis.ttl(STATUS)).toBeGreaterThan(590);
  });

  it('with no seats it succeeds without creating an (empty, ambiguous) hash', async () => {
    expect(await cacheRedis.seatsFill(STATUS, VERSION, '0', 600)).toBe(1);
    expect(await cacheRedis.exists(STATUS)).toBe(0);
  });
});

describe('seatsMarkBooked.lua', () => {
  it('bumps the version (creating it) and gives it a long TTL', async () => {
    await cacheRedis.seatsMarkBooked(STATUS, VERSION, '5');
    expect(await cacheRedis.get(VERSION)).toBe('1');
    await cacheRedis.seatsMarkBooked(STATUS, VERSION, '6');
    expect(await cacheRedis.get(VERSION)).toBe('2');
    expect(await cacheRedis.ttl(VERSION)).toBeGreaterThan(604_800 - 10);
  });

  it('does NOT create the status hash when it is absent (a partial hash would look complete)', async () => {
    await cacheRedis.seatsMarkBooked(STATUS, VERSION, '5', '6');
    expect(await cacheRedis.exists(STATUS)).toBe(0);
  });

  it('marks seats B in an existing hash, leaves the others, and keeps the hash TTL', async () => {
    await cacheRedis.seatsFill(STATUS, VERSION, '0', 600, '1', 'A', '2', 'A', '3', 'A');
    const ttlBefore = await cacheRedis.ttl(STATUS);
    await cacheRedis.seatsMarkBooked(STATUS, VERSION, '1', '3');
    expect(await cacheRedis.hgetall(STATUS)).toEqual({ '1': 'B', '2': 'A', '3': 'B' });
    expect(await cacheRedis.ttl(STATUS)).toBeLessThanOrEqual(ttlBefore);
    expect(await cacheRedis.ttl(STATUS)).toBeGreaterThan(ttlBefore - 3);
  });

  it('is idempotent for seats that are already B', async () => {
    await cacheRedis.seatsFill(STATUS, VERSION, '0', 600, '1', 'B');
    await cacheRedis.seatsMarkBooked(STATUS, VERSION, '1');
    expect(await cacheRedis.hget(STATUS, '1')).toBe('B');
  });
});

describe('the version guard (spec test 13 at the script level)', () => {
  it('a slow fill that read version v cannot overwrite a booking that committed in between', async () => {
    // Fill starts: reads the version BEFORE querying MySQL.
    const versionSeenByFill = (await cacheRedis.get(VERSION)) ?? '0';
    const staleRows = ['1', 'A', '2', 'A']; // MySQL said seat 1 was still available

    // Meanwhile a booking commits and marks seat 1 booked (hash absent, so only the version moves).
    await cacheRedis.seatsMarkBooked(STATUS, VERSION, '1');

    // The slow fill now tries to write its stale snapshot: refused.
    expect(await cacheRedis.seatsFill(STATUS, VERSION, versionSeenByFill, 600, ...staleRows)).toBe(0);
    expect(await cacheRedis.exists(STATUS)).toBe(0);

    // The next fill reads the NEW version and MySQL's new truth, and is accepted.
    const fresh = (await cacheRedis.get(VERSION)) ?? '0';
    expect(await cacheRedis.seatsFill(STATUS, VERSION, fresh, 600, '1', 'B', '2', 'A')).toBe(1);
    expect(await cacheRedis.hget(STATUS, '1')).toBe('B');
  });
});
