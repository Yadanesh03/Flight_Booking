import { config } from '../platform/config.js';
import { closeDb } from '../platform/db.js';
import { logger } from '../platform/logger.js';
import { closeRedis, waitForRedis } from '../platform/redis.js';
import { runMigrations } from '../db/migrate.js';
import { seedDemoBookings } from './bookings.js';
import { seedCatalog } from './catalog.js';

const log = logger.child({ module: 'seed' });

/**
 * `npm run seed`: deterministic (fixed PRNG seed) and idempotent. Demo users and demo bookings are
 * development conveniences and are skipped when NODE_ENV=production.
 */
async function main(): Promise<void> {
  await runMigrations();
  const redis = await waitForRedis(5000);
  if (!redis.cache || !redis.coord) throw new Error(`Redis must be running to seed: ${JSON.stringify(redis)}`);

  const catalog = await seedCatalog({
    demoUsers: !config.isProduction,
    adminEmail: config.seedAdminEmail,
    adminPassword: config.seedAdminPassword
  });
  const bookings = config.isProduction ? undefined : await seedDemoBookings();
  log.info({ catalog, bookings }, 'seed complete');
}

main()
  .then(() => Promise.all([closeDb(), closeRedis()]))
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    log.error({ err: error }, 'seed failed');
    process.exit(1);
  });
