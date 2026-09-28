import { sql } from 'drizzle-orm';
import { bigint, datetime, mysqlEnum, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';

/**
 * `auth` module tables (Architecture spec 8.1).
 * DECISION: drizzle's `datetime` builder has no `onUpdateNow()`, so the generated migration is
 * patched (scripts/patch-migration-sql.mjs) to add `ON UPDATE CURRENT_TIMESTAMP(3)` to `updated_at`.
 */
export const users = mysqlTable(
  'users',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    /** Lowercased + trimmed. */
    email: varchar('email', { length: 255 }).notNull(),
    passwordHash: varchar('password_hash', { length: 100 }).notNull(),
    role: mysqlEnum('role', ['USER', 'ADMIN']).notNull().default('USER'),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`)
  },
  (table) => [uniqueIndex('uq_users_email').on(table.email)]
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
