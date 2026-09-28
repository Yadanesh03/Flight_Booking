import { Router } from 'express';
import { rateLimit } from '../../platform/middleware/rateLimit.js';
import { requireAuth } from '../../platform/middleware/requireAuth.js';
import { flightsController } from './flights.controller.js';

/** Public catalog reads (Section 10.2). Paths are absolute so the request log shows the route pattern. */
export function flightsRouter(): Router {
  const router = Router();
  const publicRead = [requireAuth('public'), rateLimit('read')] as const;
  router.get('/api/airports', ...publicRead, flightsController.listAirports);
  router.get('/api/flights', ...publicRead, flightsController.searchFlights);
  router.get('/api/flights/:flightId', ...publicRead, flightsController.getFlight);
  return router;
}
