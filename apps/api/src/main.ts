import { SERVER_REQUEST_TIMEOUT_MS } from '@flight/shared';
import { createApp } from './app.js';
import { runMigrations } from './db/migrate.js';
import { config } from './platform/config.js';
import { pingDb } from './platform/db.js';
import { logger } from './platform/logger.js';
import { waitForRedis } from './platform/redis.js';
import { installShutdownHandlers } from './platform/shutdown.js';

const log = logger.child({ module: 'platform' });

async function main(): Promise<void> {
  // In dev the API applies pending migrations on startup (Section 7.3). Production uses `npm run migrate`.
  if (!config.isProduction) await runMigrations();

  // Open the first MySQL connection now: the initial handshake is slow and would otherwise make the
  // first /ready probe after boot spuriously fail its 1 s budget. Failure is tolerated (reported by /ready).
  await pingDb().catch((error: unknown) => log.warn({ err: error }, 'MySQL not reachable at startup'));

  // Start even if Redis is down: degraded modes (Section 10.3) and /ready report the problem.
  const redis = await waitForRedis(5000);
  if (!redis.cache || !redis.coord) log.warn({ redis }, 'starting with Redis unavailable (degraded mode)');

  const app = createApp();
  const server = app.listen(config.port, () => {
    log.info({ port: config.port, nodeEnv: config.nodeEnv }, 'API listening');
  });
  // DECISION: the 15 s "server request timeout" is applied at the HTTP-server level (socket idle,
  // request-receive and header timeouts) rather than with a per-request timer that would race the
  // handler and produce "headers already sent" errors when a slow handler finally replies.
  server.setTimeout(SERVER_REQUEST_TIMEOUT_MS);
  server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
  server.headersTimeout = SERVER_REQUEST_TIMEOUT_MS;
  installShutdownHandlers(server);
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, 'failed to start');
  process.exit(1);
});
