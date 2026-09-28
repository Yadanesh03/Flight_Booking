import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { closeDb, db } from '../platform/db.js';
import { logger } from '../platform/logger.js';

const log = logger.child({ module: 'platform' });

/** Applies pending drizzle migrations. Safe to call repeatedly; a folder with no journal is a no-op. */
export async function runMigrations(): Promise<void> {
  const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));
  if (!existsSync(`${migrationsFolder}/meta/_journal.json`)) {
    log.warn({ migrationsFolder }, 'no migrations found; skipping');
    return;
  }
  await migrate(db, { migrationsFolder });
  log.info('migrations applied');
}

// `npm run migrate` executes this file directly.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runMigrations()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      log.error({ err: error }, 'migration failed');
      process.exit(1);
    });
}
