import { Router, type RequestHandler } from 'express';
import { READINESS_TIMEOUT_MS } from '@flight/shared';
import { pingDb } from './db.js';
import { cacheRedis, coordRedis } from './redis.js';
import { isShuttingDown } from './shutdown.js';

type DependencyStatus = 'ok' | 'down';

function withTimeout(promise: Promise<unknown>, ms: number): Promise<DependencyStatus> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('down'), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve('ok');
      },
      () => {
        clearTimeout(timer);
        resolve('down');
      }
    );
  });
}

/** GET /health: 200 while the process runs. */
const health: RequestHandler = (_req, res) => {
  res.json({ status: 'ok' });
};

/**
 * GET /ready: 200 only if MySQL (`SELECT 1`) and both Redis instances (`PING`) answer within 1 s;
 * otherwise 503 with per-dependency status. Also 503 once shutdown has started.
 */
const ready: RequestHandler = async (_req, res) => {
  if (isShuttingDown()) {
    res.status(503).json({ status: 'shutting_down' });
    return;
  }
  const [mysql, redisCache, redisCoord] = await Promise.all([
    withTimeout(pingDb(), READINESS_TIMEOUT_MS),
    withTimeout(cacheRedis.ping(), READINESS_TIMEOUT_MS),
    withTimeout(coordRedis.ping(), READINESS_TIMEOUT_MS)
  ]);
  const dependencies = { mysql, redisCache, redisCoord };
  const allOk = mysql === 'ok' && redisCache === 'ok' && redisCoord === 'ok';
  res.status(allOk ? 200 : 503).json({ status: allOk ? 'ready' : 'not_ready', dependencies });
};

export function healthRouter(): Router {
  const router = Router();
  router.get('/health', health);
  router.get('/ready', ready);
  return router;
}
