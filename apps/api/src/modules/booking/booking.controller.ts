import type { RequestHandler } from 'express';
import { parseId } from '../../platform/validation.js';
import { seatMapService } from './seatMap.service.js';

const getSeatMap: RequestHandler = async (req, res) => {
  const flightId = parseId(req.params['flightId'], 'flightId');
  res.json(await seatMapService.getSeatMap(flightId, req.user?.id));
};

export const bookingController = { getSeatMap };
