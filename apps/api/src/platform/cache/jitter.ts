import { CACHE_TTL_JITTER } from '@flight/shared';

/**
 * `round(ttl x (0.9 + random() x 0.2))`: spreads expirations by +/-10 % so keys written together do
 * not all expire (and stampede the database) at the same instant. Applied to every cache TTL.
 */
export function jitter(ttlSeconds: number, random: () => number = Math.random): number {
  const spread = CACHE_TTL_JITTER * 2;
  return Math.max(1, Math.round(ttlSeconds * (1 - CACHE_TTL_JITTER + random() * spread)));
}
