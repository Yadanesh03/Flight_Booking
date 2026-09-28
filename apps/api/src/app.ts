import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { type Express, type Request, type RequestHandler } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { REQUEST_BODY_LIMIT } from '@flight/shared';
import { config } from './platform/config.js';
import { errorMiddleware, notFoundHandler } from './platform/errors.js';
import { healthRouter } from './platform/health.js';
import { logger } from './platform/logger.js';
import { originCheck } from './platform/middleware/originCheck.js';
import { requestId } from './platform/middleware/requestId.js';
import { sessionMiddleware } from './platform/middleware/session.js';
import { authRouter, sessionService } from './modules/auth/index.js';
import { bookingRouter } from './modules/booking/index.js';
import { flightsAdminRouter, flightsRouter } from './modules/flights/index.js';
import { testRouter } from './platform/testSupport.js';

/**
 * Builds the Express app. No `listen` here so integration tests can drive it with supertest.
 *
 * HTTP pipeline (Section 10.1):
 *   request ID -> helmet/body/logging -> origin check -> global rate limit -> session resolution
 *   -> route auth -> route rate limit -> module router -> error middleware
 * Steps after request logging are added per phase; module routers are mounted in `mountApi`.
 */
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  // TRUST_PROXY is false locally so X-Forwarded-For cannot be spoofed (Section 12.3).
  app.set('trust proxy', config.trustProxy);

  // 1. Request ID
  app.use(requestId);

  // 2. helmet, JSON body limit, request logging
  // DECISION: HSTS and CSP `upgrade-insecure-requests` are only sent when the deployment is served
  // over HTTPS (COOKIE_SECURE=true). On the plain-HTTP localhost demo they would make browsers
  // rewrite same-origin asset requests to https:// and break the SPA.
  const cspDefaults = helmet.contentSecurityPolicy.getDefaultDirectives();
  if (!config.cookieSecure) delete cspDefaults['upgrade-insecure-requests'];
  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: cspDefaults },
      strictTransportSecurity: config.cookieSecure
    })
  );
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as Request).requestId,
      customProps: (req) => ({ requestId: (req as Request).requestId, module: 'http' }),
      customLogLevel: (_req, res, error) => {
        if (error !== undefined || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      customSuccessMessage: () => 'request completed',
      customErrorMessage: () => 'request errored',
      customAttributeKeys: { responseTime: 'durationMs' },
      // One log line per request: method, route pattern, status, duration. No headers, no bodies.
      serializers: {
        req: (req: { method?: string; raw?: Request }) => ({
          method: req.method,
          route: routePattern(req.raw)
        }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode })
      },
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' }
    })
  );
  app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

  // Health endpoints are outside /api and skip the pipeline's auth and rate limiting.
  app.use(healthRouter());

  if (config.isTest) app.use(testRouter());

  // 3. Origin check (CSRF defence), 5. session resolution. (4, the global rate limit, is added with Phase 7.)
  app.use('/api', originCheck);
  app.use('/api', sessionMiddleware((sid) => sessionService.resolve(sid)));

  // 6-8. Route auth, route rate limit and the module routers.
  mountApi(app);

  // In production the app serves the SPA from SERVE_STATIC_DIR with an index.html fallback,
  // so frontend and API share one origin.
  if (config.serveStaticDir !== undefined) mountStatic(app, config.serveStaticDir);

  app.use('/api', notFoundHandler);
  app.use(errorMiddleware);
  return app;
}

/** Module routers. Each module exposes its router through its index (Section 3.3). */
function mountApi(app: Express): void {
  app.use(authRouter());
  app.use(flightsRouter());
  app.use(flightsAdminRouter());
  app.use(bookingRouter());
}

function mountStatic(app: Express, dir: string): void {
  const root = resolve(dir);
  if (!existsSync(resolve(root, 'index.html'))) {
    logger.warn({ dir: root }, 'SERVE_STATIC_DIR has no index.html; static serving disabled');
    return;
  }
  app.use(express.static(root, { index: false, maxAge: '1h' }));
  const spa: RequestHandler = (req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) {
      next();
      return;
    }
    res.sendFile(resolve(root, 'index.html'));
  };
  app.use(spa);
}

function routePattern(req: Request | undefined): string {
  const path = (req?.route as { path?: unknown } | undefined)?.path;
  return typeof path === 'string' ? path : 'unmatched';
}
