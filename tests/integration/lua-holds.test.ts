import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_FLIGHTS_WITH_ACTIVE_HOLDS, MAX_SEATS_PER_FLIGHT_HOLD } from '@flight/shared';
import { coordRedis } from '../../apps/api/src/platform/redis.js';
import { resetState, startTestApp, stopTestApp } from './helpers/testApp.js';
import { sleep } from './helpers/fixtures.js';

/** holdAcquire.lua and holdRelease.lua against a real Redis 7.4+ (per-field HEXPIRE) - Section 23.1. */
beforeAll(async () => {
  await startTestApp();
});
afterAll(stopTestApp);
beforeEach(resetState);

const holdsKey = (flight: number) => `bs:holds:${flight}`;
const userKey = (user: number) => `bs:userholds:${user}`;

function acquire(user: number, flight: number, seats: number[], ttl = 60) {
  return coordRedis.holdAcquire(
    holdsKey(flight),
    userKey(user),
    String(user),
    String(flight),
    ttl,
    MAX_SEATS_PER_FLIGHT_HOLD,
    MAX_FLIGHTS_WITH_ACTIVE_HOLDS,
    ...seats.map(String)
  );
}

const release = (user: number, flight: number, seats: number[] = []) =>
  coordRedis.holdRelease(holdsKey(flight), userKey(user), String(user), String(flight), ...seats.map(String));

async function heldSeats(flight: number): Promise<Record<string, number>> {
  const hash = await coordRedis.hgetall(holdsKey(flight));
  return Object.fromEntries(Object.entries(hash).map(([seat, value]) => [seat, Number(value.split('|')[0])]));
}

const expiryOf = async (flight: number, seat: number): Promise<number> => Number((await coordRedis.hget(holdsKey(flight), String(seat)))!.split('|')[1]);

describe('holdAcquire.lua', () => {
  it('acquires seats atomically with a per-field TTL on both hashes', async () => {
    expect(await acquire(1, 10, [101, 102, 103], 60)).toEqual(['OK', '3']);
    expect(await heldSeats(10)).toEqual({ '101': 1, '102': 1, '103': 1 });
    expect(Object.keys(await coordRedis.hgetall(userKey(1))).sort()).toEqual(['10:101', '10:102', '10:103']);

    for (const [key, field] of [
      [holdsKey(10), '101'],
      [userKey(1), '10:101']
    ] as const) {
      const [ttl] = (await coordRedis.call('HTTL', key, 'FIELDS', 1, field)) as number[];
      expect(ttl).toBeGreaterThan(55);
      expect(ttl).toBeLessThanOrEqual(60);
    }
  });

  it('stamps expiry from the Redis server clock, not the caller\'s', async () => {
    const [seconds, micros] = await coordRedis.time();
    const redisNowMs = Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
    await acquire(1, 10, [101], 60);
    const expiresAt = await expiryOf(10, 101);
    expect(Math.abs(expiresAt - (redisNowMs + 60_000))).toBeLessThan(2000);
    // and the user hash mirrors it
    expect(Number(await coordRedis.hget(userKey(1), '10:101'))).toBe(expiresAt);
  });

  it('is all-or-nothing: any conflicting seat rejects the whole request and changes nothing', async () => {
    await acquire(2, 10, [102]); // user 2 holds 102
    const result = await acquire(1, 10, [101, 102, 103]);
    expect(result).toEqual(['CONFLICT', '102']);
    expect(await heldSeats(10)).toEqual({ '102': 2 }); // 101 and 103 were NOT taken
    expect(await coordRedis.hlen(userKey(1))).toBe(0);
  });

  it('reports every conflicting seat', async () => {
    await acquire(2, 10, [102, 104]);
    const [outcome, ...conflicts] = await acquire(1, 10, [101, 102, 103, 104]);
    expect(outcome).toBe('CONFLICT');
    expect(conflicts.sort()).toEqual(['102', '104']);
  });

  it('never extends a hold the user already has (same seats: 0 added, same expiry, same TTL)', async () => {
    await acquire(1, 10, [101, 102], 60);
    const before = await expiryOf(10, 101);
    await sleep(1100);
    expect(await acquire(1, 10, [101, 102], 60)).toEqual(['OK', '0']);
    expect(await expiryOf(10, 101)).toBe(before);
    const [ttl] = (await coordRedis.call('HTTL', holdsKey(10), 'FIELDS', 1, '101')) as number[];
    expect(ttl).toBeLessThanOrEqual(59); // it kept counting down; it was not reset to 60
  });

  it('replace semantics: seats not in the new set are released, kept seats keep their expiry', async () => {
    await acquire(1, 10, [101, 102], 60); // {A, B}
    const keptExpiry = await expiryOf(10, 102);
    await sleep(50);
    expect(await acquire(1, 10, [102, 103], 60)).toEqual(['OK', '1']); // {B, C}: only C is new
    expect(await heldSeats(10)).toEqual({ '102': 1, '103': 1 });
    expect(await expiryOf(10, 102)).toBe(keptExpiry);
    expect(await expiryOf(10, 103)).toBeGreaterThan(keptExpiry);
    expect(Object.keys(await coordRedis.hgetall(userKey(1))).sort()).toEqual(['10:102', '10:103']);
    // the released seat is immediately available to someone else
    expect(await acquire(2, 10, [101])).toEqual(['OK', '1']);
  });

  it('a rejected replacement releases nothing (conflict is checked before any release)', async () => {
    await acquire(1, 10, [101, 102]);
    await acquire(2, 10, [109]);
    expect((await acquire(1, 10, [102, 109]))[0]).toBe('CONFLICT');
    expect(await heldSeats(10)).toEqual({ '101': 1, '102': 1, '109': 2 });
  });

  it(`enforces ${MAX_SEATS_PER_FLIGHT_HOLD} seats per flight (and rejects an empty request) without side effects`, async () => {
    expect(await acquire(1, 10, [1, 2, 3, 4, 5, 6])).toEqual(['OK', '6']);
    await release(1, 10);
    expect(await acquire(1, 10, [1, 2, 3, 4, 5, 6, 7])).toEqual(['SEAT_LIMIT']);
    expect(await coordRedis.hlen(holdsKey(10))).toBe(0);
    expect(await acquire(1, 10, [])).toEqual(['SEAT_LIMIT']);
  });

  it(`enforces ${MAX_FLIGHTS_WITH_ACTIVE_HOLDS} flights with active holds per user`, async () => {
    expect(await acquire(1, 10, [101])).toEqual(['OK', '1']);
    expect(await acquire(1, 11, [201])).toEqual(['OK', '1']);
    expect(await acquire(1, 12, [301])).toEqual(['FLIGHT_LIMIT']);
    expect(await coordRedis.exists(holdsKey(12))).toBe(0);
    // Changing the set on a flight the user already holds is not a new flight.
    expect(await acquire(1, 10, [102])).toEqual(['OK', '1']);
    expect(await acquire(1, 11, [201, 202])).toEqual(['OK', '1']);
    // After releasing a flight the third one is allowed.
    await release(1, 10);
    expect(await acquire(1, 12, [301])).toEqual(['OK', '1']);
    // Another user is unaffected by user 1's flights.
    expect(await acquire(2, 12, [302])).toEqual(['OK', '1']);
  });

  it('replacing on one flight never touches the user\'s holds on another flight or other users\' holds', async () => {
    await acquire(1, 10, [101]);
    await acquire(1, 11, [201]);
    await acquire(2, 10, [102]);
    await acquire(1, 10, [103]); // replace on flight 10: {101} -> {103}
    expect(await heldSeats(10)).toEqual({ '102': 2, '103': 1 });
    expect(await heldSeats(11)).toEqual({ '201': 1 });
  });

  it('holds expire on their own, per field, from both hashes (spec test 5 at the script level)', async () => {
    await acquire(1, 10, [101], 1);
    await sleep(600);
    await acquire(1, 10, [101, 102], 1); // 101 keeps its original expiry; 102 gets a fresh 1 s
    expect(await heldSeats(10)).toEqual({ '101': 1, '102': 1 });
    await sleep(700); // t = 1.3 s: 101 (original) is gone, 102 (added at 0.6 s) is not yet
    expect(await heldSeats(10)).toEqual({ '102': 1 });
    expect(Object.keys(await coordRedis.hgetall(userKey(1)))).toEqual(['10:102']);
    await sleep(600); // t = 1.9 s
    expect(await heldSeats(10)).toEqual({});
    expect(await coordRedis.hlen(userKey(1))).toBe(0);
    // Once expired, another user can take the seat.
    expect(await acquire(2, 10, [101])).toEqual(['OK', '1']);
  });

  it('spec test 1 at the script level: 50 users race for one seat; exactly one wins', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => acquire(i + 1, 10, [101])));
    expect(results.filter((r) => r[0] === 'OK')).toHaveLength(1);
    expect(results.filter((r) => r[0] === 'CONFLICT')).toHaveLength(49);
    expect(Object.keys(await heldSeats(10))).toEqual(['101']);
  });

  it('racing multi-seat requests over overlapping seats never leave a partial hold', async () => {
    const results = await Promise.all([
      acquire(1, 10, [1, 2, 3, 4]),
      acquire(2, 10, [4, 3, 2, 1]),
      acquire(3, 10, [3, 4, 5, 6]),
      acquire(4, 10, [6, 5, 1, 2])
    ]);
    const winners = results.map((r, i) => (r[0] === 'OK' ? i + 1 : 0)).filter(Boolean);
    const held = await heldSeats(10);
    // Every held seat belongs to a winner, and each winner holds exactly its 4 seats.
    for (const user of winners) expect(Object.values(held).filter((u) => u === user)).toHaveLength(4);
    expect(Object.values(held).length).toBe(winners.length * 4);
    for (const owner of Object.values(held)) expect(winners).toContain(owner);
  });
});

describe('holdRelease.lua', () => {
  it('with no seat ids releases all of the user\'s seats on that flight only', async () => {
    await acquire(1, 10, [101, 102]);
    await acquire(1, 11, [201]);
    await acquire(2, 10, [103]);
    expect(await release(1, 10)).toBe(2);
    expect(await heldSeats(10)).toEqual({ '103': 2 });
    expect(await heldSeats(11)).toEqual({ '201': 1 });
    expect(Object.keys(await coordRedis.hgetall(userKey(1)))).toEqual(['11:201']);
  });

  it('with seat ids releases exactly those seats (used after a booking)', async () => {
    await acquire(1, 10, [101, 102, 103]);
    expect(await release(1, 10, [101, 103])).toBe(2);
    expect(await heldSeats(10)).toEqual({ '102': 1 });
    expect(Object.keys(await coordRedis.hgetall(userKey(1)))).toEqual(['10:102']);
  });

  it('never releases a seat held by someone else, even if asked to', async () => {
    await acquire(2, 10, [102]);
    expect(await release(1, 10, [102])).toBe(0);
    expect(await heldSeats(10)).toEqual({ '102': 2 });
    expect(await release(1, 10)).toBe(0);
    expect(await heldSeats(10)).toEqual({ '102': 2 });
  });

  it('is idempotent and safe on empty state', async () => {
    expect(await release(1, 10)).toBe(0);
    await acquire(1, 10, [101]);
    expect(await release(1, 10)).toBe(1);
    expect(await release(1, 10)).toBe(0);
  });

  it('cleans up the user\'s own index even when the seat hold already expired or was taken over', async () => {
    await acquire(1, 10, [101], 1);
    await sleep(1300); // hold expired (and its user-index field with it)
    await acquire(2, 10, [101]);
    expect(await release(1, 10, [101])).toBe(0); // user 1 no longer owns it
    expect(await heldSeats(10)).toEqual({ '101': 2 }); // user 2's hold is intact
  });
});
