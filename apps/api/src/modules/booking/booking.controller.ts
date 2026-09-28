import type { RequestHandler } from 'express';
import {
  bookingListQuerySchema,
  bookingRefSchema,
  bookingRequestSchema,
  holdsRequestSchema,
  idempotencyKeySchema
} from '@flight/shared';
import { config } from '../../platform/config.js';
import { AppError } from '../../platform/errors.js';
import { requireUser } from '../../platform/requestContext.js';
import { parseId } from '../../platform/validation.js';
import { bookingService } from './booking.service.js';
import { holdService } from './hold.service.js';
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

  // Test-only escape hatch (spec test 2). The header is not even read outside NODE_ENV=test.
  const skipHoldCheck = config.isTest && req.get('x-test-skip-holds') === '1';
  const { booking, replayed } = await bookingService.createBooking({ userId, idempotencyKey, request, skipHoldCheck });
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

/** PUT /api/flights/:flightId/holds  { seatIds }: replaces the user's held set on this flight. */
const putHolds: RequestHandler = async (req, res) => {
  const { id: userId } = requireUser(req);
  const flightId = parseId(req.params['flightId'], 'flightId');
  const { seatIds } = holdsRequestSchema.parse(req.body);
  res.json(await holdService.acquire(userId, flightId, seatIds));
};

const deleteHolds: RequestHandler = async (req, res) => {
  const { id: userId } = requireUser(req);
  await holdService.release(userId, parseId(req.params['flightId'], 'flightId'));
  res.status(204).end();
};

const listHolds: RequestHandler = async (req, res) => {
  const { id: userId } = requireUser(req);
  res.json(await holdService.list(userId));
};

const adminInventory: RequestHandler = async (req, res) => {
  res.json(await seatMapService.getInventory(parseId(req.params['flightId'], 'flightId')));
};

export const bookingController = { getSeatMap, putHolds, deleteHolds, listHolds, createBooking, listBookings, getBooking, adminInventory };
