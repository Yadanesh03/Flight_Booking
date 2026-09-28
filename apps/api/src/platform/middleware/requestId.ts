import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Step 1 of the pipeline (Section 10.1): accept an incoming `X-Request-Id` only if it is a valid
 * UUID, otherwise generate one; echo it in the response. (Untrusted free-form IDs would let a caller
 * forge log lines.)
 */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get('x-request-id');
  const id = incoming !== undefined && UUID.test(incoming) ? incoming.toLowerCase() : randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
};
