import { Router } from 'express';
import { rateLimit } from '../../platform/middleware/rateLimit.js';
import { requireAuth } from '../../platform/middleware/requireAuth.js';
import { bookingController } from './booking.controller.js';

/** Route table for Section 10.2. Paths are absolute so the request log shows the route pattern. */
export function bookingRouter(): Router {
  const router = Router();
  const session = requireAuth('session');
  router.get('/api/flights/:flightId/seats', requireAuth('optional'), rateLimit('read'), bookingController.getSeatMap);
  router.put('/api/flights/:flightId/holds', session, rateLimit('holds'), bookingController.putHolds);
  router.delete('/api/flights/:flightId/holds', session, rateLimit('holds'), bookingController.deleteHolds);
  router.get('/api/holds', session, rateLimit('read'), bookingController.listHolds);
  router.post('/api/bookings', session, rateLimit('bookings'), bookingController.createBooking);
  router.get('/api/bookings', session, rateLimit('read'), bookingController.listBookings);
  router.get('/api/bookings/:bookingRef', session, rateLimit('read'), bookingController.getBooking);
  router.get('/api/admin/inventory/flights/:flightId', requireAuth('admin'), rateLimit('admin'), bookingController.adminInventory);
  return router;
}
