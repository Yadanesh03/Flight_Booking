import { Router } from 'express';
import { requireAuth } from '../../platform/middleware/requireAuth.js';
import { flightsController } from './flights.controller.js';

/** Public catalog reads (Section 10.2). Paths are absolute so the request log shows the route pattern. */
export function flightsRouter(): Router {
  const router = Router();
  router.get('/api/airports', requireAuth('public'), flightsController.listAirports);
  router.get('/api/flights', requireAuth('public'), flightsController.searchFlights);
  router.get('/api/flights/:flightId', requireAuth('public'), flightsController.getFlight);
  return router;
}
