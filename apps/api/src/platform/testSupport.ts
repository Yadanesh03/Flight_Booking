import { Router } from 'express';
import { config } from './config.js';

/**
 * Test-only support (Section 19.4): query counters and fault-injection hooks.
 *
 * Everything here is inert unless NODE_ENV=test, and the HTTP routes are never registered
 * otherwise (see `testRouter`). Fault hooks let integration tests prove rollback/recovery paths
 * (e.g. throw after the seat UPDATE in the confirm transaction).
 */

export interface TestCounters {
  dbQueries: { flightById: number; seatStatus: number };
  paymentCalls: number;
}

function emptyCounters(): TestCounters {
  return { dbQueries: { flightById: 0, seatStatus: 0 }, paymentCalls: 0 };
}

let counters = emptyCounters();

export function countDbQuery(name: keyof TestCounters['dbQueries']): void {
  if (config.isTest) counters.dbQueries[name] += 1;
}

export function countPaymentCall(): void {
  if (config.isTest) counters.paymentCalls += 1;
}

export function getTestCounters(): TestCounters {
  return structuredClone(counters);
}

export function resetTestCounters(): void {
  counters = emptyCounters();
}

export type TestHookName =
  /** Confirm transaction: right after `UPDATE flight_seats SET status='BOOKED'`. */
  | 'afterSeatUpdate'
  /** Booking creation: right after the PENDING claim insert. */
  | 'afterClaim'
  /** Publish transaction: right after inventory rows are inserted. */
  | 'afterInventoryInsert'
  /** Seat status cache fill: after the DB read, before the cache write. */
  | 'seatFillAfterDbRead'
  /** Confirm transaction: right after the seats are locked (used to widen race windows). */
  | 'afterSeatLock';

type HookFn = () => void | Promise<void>;
const hooks = new Map<TestHookName, HookFn>();

export function setTestHook(name: TestHookName, fn: HookFn): void {
  if (!config.isTest) throw new Error('Test hooks can only be set when NODE_ENV=test.');
  hooks.set(name, fn);
}

export function clearTestHooks(): void {
  hooks.clear();
}

/** Runs the hook registered under `name`, if any. Always a no-op outside NODE_ENV=test. */
export async function runTestHook(name: TestHookName): Promise<void> {
  if (!config.isTest) return;
  const hook = hooks.get(name);
  if (hook) await hook();
}

/** `GET /api/_test/stats` and `POST /api/_test/reset`. Only mount when `config.isTest`. */
export function testRouter(): Router {
  if (!config.isTest) throw new Error('testRouter must never be created outside NODE_ENV=test.');
  const router = Router();
  router.get('/api/_test/stats', (_req, res) => {
    res.json(getTestCounters());
  });
  router.post('/api/_test/reset', (_req, res) => {
    resetTestCounters();
    res.status(204).end();
  });
  return router;
}
