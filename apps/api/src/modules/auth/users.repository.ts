import { eq } from 'drizzle-orm';
import type { Executor } from '../../platform/db.js';
import { users, type NewUserRow, type UserRow } from './schema.js';

/** Data access only: no business rules here. */
export const usersRepository = {
  async findByEmail(executor: Executor, email: string): Promise<UserRow | undefined> {
    const rows = await executor.select().from(users).where(eq(users.email, email)).limit(1);
    return rows[0];
  },

  async findById(executor: Executor, id: number): Promise<UserRow | undefined> {
    const rows = await executor.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0];
  },

  /** Returns the new user's id. Throws a MySQL ER_DUP_ENTRY error when the email exists. */
  async insert(executor: Executor, values: NewUserRow): Promise<number> {
    const [result] = await executor.insert(users).values(values);
    return result.insertId;
  }
};
