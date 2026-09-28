import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import { sql } from 'drizzle-orm';
import mysql from 'mysql2/promise';
import {
  MYSQL_CONNECT_TIMEOUT_MS,
  MYSQL_CONNECTION_LIMIT,
  MYSQL_QUEUE_LIMIT
} from '@flight/shared';
import { config } from './config.js';

/**
 * A drizzle handle: either the shared pool (autocommit) or a single connection inside a transaction.
 * Repositories take an `Executor` so services can decide whether a call joins their transaction.
 */
export type Executor = MySql2Database;

const pool = mysql.createPool({
  uri: config.databaseUrl,
  connectionLimit: MYSQL_CONNECTION_LIMIT,
  queueLimit: MYSQL_QUEUE_LIMIT,
  connectTimeout: MYSQL_CONNECT_TIMEOUT_MS,
  waitForConnections: true,
  // All timestamps are UTC DATETIME(3); mysql2 must convert to/from JS Dates as UTC.
  timezone: 'Z',
  charset: 'utf8mb4'
});

// Belt and braces on top of the server's default-time-zone: make NOW(3) UTC on every connection,
// even against a MySQL server that was not started with the compose settings.
pool.pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'");
});

export const db: Executor = drizzle(pool);

export interface TransactionOptions {
  /**
   * Sets the session `innodb_lock_wait_timeout` for this transaction only. The connection is reset
   * to the server default before it returns to the pool.
   */
  lockWaitTimeoutSeconds?: number;
}

/**
 * Runs `fn` in a transaction on a dedicated connection. Commits when `fn` resolves, rolls back when
 * it throws. Services own transactions; repositories receive the `tx` executor.
 */
export async function withTransaction<T>(fn: (tx: Executor) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
  const connection = await pool.getConnection();
  let discard = false;
  const lockWait = options.lockWaitTimeoutSeconds;
  try {
    if (lockWait !== undefined) {
      await connection.query(`SET SESSION innodb_lock_wait_timeout = ${Math.trunc(lockWait)}`);
    }
    await connection.beginTransaction();
    try {
      const result = await fn(drizzle(connection));
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        // The connection is broken; it must not go back to the pool.
        discard = true;
      }
      throw error;
    }
  } finally {
    if (!discard && lockWait !== undefined) {
      try {
        await connection.query('SET SESSION innodb_lock_wait_timeout = DEFAULT');
      } catch {
        discard = true;
      }
    }
    if (discard) connection.destroy();
    else connection.release();
  }
}

/** Liveness probe used by /ready. */
export async function pingDb(): Promise<void> {
  await db.execute(sql`SELECT 1`);
}

export async function closeDb(): Promise<void> {
  await pool.end();
}

/** Raw pool access for the migrator and tests only. */
export function getPool(): mysql.Pool {
  return pool;
}
