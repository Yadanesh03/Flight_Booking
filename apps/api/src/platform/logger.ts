import pino, { type Logger } from 'pino';
import { config } from './config.js';

/**
 * Structured JSON logs to stdout. Base fields: level, time, requestId, module (added via child
 * loggers) and, when present, userId / flightId / bookingRef.
 *
 * Never log passwords, session IDs, cookies or auth request bodies. Hash IPs/emails if logged.
 */
export const logger: Logger = pino({
  level: config.logLevel,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.sid'
    ],
    censor: '[redacted]'
  }
});

export function moduleLogger(name: string): Logger {
  return logger.child({ module: name });
}

const lastLogged = new Map<string, number>();

/**
 * Logs at most once per `intervalMs` per event name. Used for degraded-mode warnings
 * (RATE_LIMIT_BYPASSED, CACHE_UNAVAILABLE) that would otherwise flood the logs during an outage.
 */
export function logThrottled(
  log: Logger,
  event: string,
  intervalMs: number,
  fields: Record<string, unknown> = {}
): void {
  const now = Date.now();
  const last = lastLogged.get(event);
  if (last !== undefined && now - last < intervalMs) return;
  lastLogged.set(event, now);
  log.warn({ event, ...fields }, event);
}
