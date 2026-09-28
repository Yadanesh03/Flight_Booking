import type { RequestHandler } from 'express';
import { bookingListQuerySchema, bookingRefSchema, bookingRequestSchema, idempotencyKeySchema } from '@flight/shared';
import { AppError } from '../../platform/errors.js';
import { requireUser } from '../../platform/requestContext.js';
import { parseId } from '../../platform/validation.js';
import { bookingService } from './booking.service.js';
import { seatMapService } from './seatMap.service.js';

const getSeatMap: RequestHandler = async (req, res) => {
  const flightId = parseId(req.params['flightId'], 'flightId');
  res.json(await seatMapService.getSeatMap(flightId, req.user?.id));
};

/** POST /api/bookings: `Idempotency-Key: <UUID v4>` is required. 201 for a new booking, 200 on replay. */
const createBooking: RequestHandler = async (req, res) => {
  const { id: userId } = requireUser(req); // identity always comes from the session, never the body
  const header = req.get('idempotency-key');
  if (header === undefined || header.trim() === '') throw new AppError('IDEMPOTENCY_KEY_REQUIRED');
  const idempotencyKey = idempotencyKeySchema.parse(header.trim()).toLowerCase();
  const request = bookingRequestSchema.parse(req.body);

  const { booking, replayed } = await bookingService.createBooking({ userId, idempotencyKey, request });
  if (replayed) res.setHeader('Idempotent-Replayed', 'true');
  res.status(replayed ? 200 : 201).json(booking);
};

const listBookings: RequestHandler = async (req, res) => {
  const { id: userId } = requireUser(req);
  res.json(await bookingService.listBookings(userId, bookingListQuerySchema.parse(req.query)));
};

const getBooking: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const bookingRef = bookingRefSchema.parse(req.params['bookingRef']);
  res.json(await bookingService.getBooking(bookingRef, user));
};

export const bookingController = { getSeatMap, createBooking, listBookings, getBooking };
