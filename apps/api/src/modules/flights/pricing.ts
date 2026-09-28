import {
  PRICE_AISLE_SURCHARGE,
  PRICE_BUSINESS_MULTIPLIER,
  PRICE_ECONOMY_MULTIPLIER,
  PRICE_MIDDLE_SURCHARGE,
  PRICE_WINDOW_SURCHARGE,
  type CabinClass,
  type SeatType
} from '@flight/shared';
import { fromMinorUnits, toMinorUnits } from '../../platform/money.js';

const SURCHARGE: Record<SeatType, number> = {
  WINDOW: PRICE_WINDOW_SURCHARGE,
  AISLE: PRICE_AISLE_SURCHARGE,
  MIDDLE: PRICE_MIDDLE_SURCHARGE
};

const MULTIPLIER: Record<CabinClass, number> = {
  BUSINESS: PRICE_BUSINESS_MULTIPLIER,
  ECONOMY: PRICE_ECONOMY_MULTIPLIER
};

/**
 * Per-seat price (Section 13.3):
 *   price = base_price x (BUSINESS ? 2.5 : 1.0) + (WINDOW ? 350 : AISLE ? 250 : 0), rounded to 2 decimals.
 * Computed in integer paise (multiplier in tenths, half-up rounding) so no float error can creep
 * into an amount. `basePrice` and the result are decimal strings.
 */
export function computeSeatPrice(basePrice: string, cabin: CabinClass, seatType: SeatType): string {
  const baseMinor = toMinorUnits(basePrice);
  const multiplierTenths = Math.round(MULTIPLIER[cabin] * 10);
  const scaledMinor = Math.floor((baseMinor * multiplierTenths + 5) / 10);
  return fromMinorUnits(scaledMinor + SURCHARGE[seatType] * 100);
}
