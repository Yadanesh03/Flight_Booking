import type { RequestHandler } from 'express';
import {
  adminFlightListQuerySchema,
  aircraftCreateSchema,
  flightCreateSchema,
  flightPatchSchema,
  flightSearchQuerySchema
} from '@flight/shared';
import { parseId } from '../../platform/validation.js';
import { catalogService } from './catalog.service.js';
import { flightsAdminService } from './admin.service.js';
import { flightsService } from './flights.service.js';

// --- Public reads -----------------------------------------------------------

const listAirports: RequestHandler = async (_req, res) => {
  res.json({ airports: await catalogService.listAirports() });
};

const searchFlights: RequestHandler = async (req, res) => {
  const query = flightSearchQuerySchema.parse(req.query);
  res.json({ flights: await flightsService.search(query) });
};

const getFlight: RequestHandler = async (req, res) => {
  const flightId = parseId(req.params['flightId'], 'flightId');
  res.json({ flight: await flightsService.getFlight(flightId, req.user?.role === 'ADMIN') });
};

// --- Admin ------------------------------------------------------------------

const createAircraft: RequestHandler = async (req, res) => {
  const input = aircraftCreateSchema.parse(req.body);
  res.status(201).json({ aircraft: await catalogService.createAircraft(input) });
};

const listAircraft: RequestHandler = async (_req, res) => {
  res.json({ aircraft: await catalogService.listAircraft() });
};

const createFlight: RequestHandler = async (req, res) => {
  const input = flightCreateSchema.parse(req.body);
  res.status(201).json({ flight: await flightsAdminService.createFlight(input) });
};

const listAdminFlights: RequestHandler = async (req, res) => {
  const query = adminFlightListQuerySchema.parse(req.query);
  res.json(await flightsAdminService.listFlights(query));
};

const patchFlight: RequestHandler = async (req, res) => {
  const id = parseId(req.params['id'], 'id');
  const patch = flightPatchSchema.parse(req.body);
  res.json({ flight: await flightsAdminService.patchFlight(id, patch) });
};

const deleteFlight: RequestHandler = async (req, res) => {
  await flightsAdminService.deleteFlight(parseId(req.params['id'], 'id'));
  res.status(204).end();
};

const cancelFlight: RequestHandler = async (req, res) => {
  const id = parseId(req.params['id'], 'id');
  res.json({ flight: await flightsAdminService.cancelFlight(id) });
};

export const flightsController = {
  listAirports,
  searchFlights,
  getFlight,
  createAircraft,
  listAircraft,
  createFlight,
  listAdminFlights,
  patchFlight,
  deleteFlight,
  cancelFlight
};
