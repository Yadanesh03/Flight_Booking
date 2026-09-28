import { Router } from 'express';
import { requireAuth } from '../../platform/middleware/requireAuth.js';
import { bookingController } from './booking.controller.js';

/** Route table for Section 10.2. Paths are absolute so the request log shows the route pattern. */
export function bookingRouter(): Router {
  const router = Router();
  router.get('/api/flights/:flightId/seats', requireAuth('optional'), bookingController.getSeatMap);
  router.post('/api/bookings', requireAuth('session'), bookingController.createBooking);
  router.get('/api/bookings', requireAuth('session'), bookingController.listBookings);
  router.get('/api/bookings/:bookingRef', requireAuth('session'), bookingController.getBooking);
  return router;
}
