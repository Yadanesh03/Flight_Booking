import { Router } from 'express';
import { requireAuth } from '../../platform/middleware/requireAuth.js';
import { flightsController } from './flights.controller.js';

/** `/api/admin/aircraft/*` and `/api/admin/flights/*` (Section 13.2). All admin-only. */
export function flightsAdminRouter(): Router {
  const router = Router();
  const admin = requireAuth('admin');
  router.post('/api/admin/aircraft', admin, flightsController.createAircraft);
  router.get('/api/admin/aircraft', admin, flightsController.listAircraft);
  router.post('/api/admin/flights', admin, flightsController.createFlight);
  router.get('/api/admin/flights', admin, flightsController.listAdminFlights);
  router.patch('/api/admin/flights/:id', admin, flightsController.patchFlight);
  router.delete('/api/admin/flights/:id', admin, flightsController.deleteFlight);
  router.post('/api/admin/flights/:id/publish', admin, flightsController.publishFlight);
  router.post('/api/admin/flights/:id/cancel', admin, flightsController.cancelFlight);
  return router;
}
