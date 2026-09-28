import type { Server } from 'node:http';
import { GRACEFUL_SHUTDOWN_TIMEOUT_MS } from '@flight/shared';
import { closeDb } from './db.js';
import { logger } from './logger.js';
import { closeRedis } from './redis.js';

const log = logger.child({ module: 'platform' });

let shuttingDown = false;

/** `/ready` returns 503 as soon as shutdown starts so load balancers stop sending traffic. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Graceful shutdown (Section 19.5): log, flip /ready, stop accepting connections, wait for in-flight
 * requests up to the timeout, close MySQL + Redis, exit 0 (exit 1 on timeout).
 */
export async function shutdown(server: Server, signal: string): Promise<number> {
  if (shuttingDown) return 0;
  shuttingDown = true;
  log.info({ event: 'SHUTDOWN_STARTED', signal }, 'SHUTDOWN_STARTED');

  const closed = new Promise<'closed'>((resolve, reject) => {
    // Stops accepting new connections; the callback fires once every open connection has ended.
    server.close((error) => (error ? reject(error) : resolve('closed')));
    // Idle keep-alive connections would otherwise hold close() open until they time out.
    server.closeIdleConnections();
  });
  const timedOut = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), GRACEFUL_SHUTDOWN_TIMEOUT_MS).unref();
  });

  let exitCode = 0;
  try {
    const outcome = await Promise.race([closed, timedOut]);
    if (outcome === 'timeout') {
      log.error({ event: 'SHUTDOWN_TIMEOUT' }, 'in-flight requests did not finish in time');
      server.closeAllConnections();
      exitCode = 1;
    }
  } catch (error) {
    log.error({ err: error }, 'error while closing the HTTP server');
    exitCode = 1;
  }

  await Promise.allSettled([closeDb(), closeRedis()]);
  log.info({ event: 'SHUTDOWN_COMPLETE', exitCode }, 'SHUTDOWN_COMPLETE');
  return exitCode;
}

/** Wires SIGTERM/SIGINT to `shutdown` and exits the process with its result. */
export function installShutdownHandlers(server: Server): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void shutdown(server, signal).then((code) => process.exit(code));
    });
  }
}
