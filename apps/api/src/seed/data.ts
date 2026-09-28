import type { AirportDto } from '@flight/shared';

/** Seed reference data (Architecture spec, Section 22). All flight data is synthetic. */

export const AIRPORTS: AirportDto[] = [
  { code: 'BOM', name: 'Chhatrapati Shivaji Maharaj International Airport', city: 'Mumbai', country: 'India', timezone: 'Asia/Kolkata' },
  { code: 'DEL', name: 'Indira Gandhi International Airport', city: 'Delhi', country: 'India', timezone: 'Asia/Kolkata' },
  { code: 'BLR', name: 'Kempegowda International Airport', city: 'Bengaluru', country: 'India', timezone: 'Asia/Kolkata' },
  { code: 'HYD', name: 'Rajiv Gandhi International Airport', city: 'Hyderabad', country: 'India', timezone: 'Asia/Kolkata' },
  { code: 'MAA', name: 'Chennai International Airport', city: 'Chennai', country: 'India', timezone: 'Asia/Kolkata' },
  { code: 'CCU', name: 'Netaji Subhas Chandra Bose International Airport', city: 'Kolkata', country: 'India', timezone: 'Asia/Kolkata' },
  { code: 'GOI', name: 'Manohar International Airport', city: 'Goa', country: 'India', timezone: 'Asia/Kolkata' },
  { code: 'PNQ', name: 'Pune Airport', city: 'Pune', country: 'India', timezone: 'Asia/Kolkata' },
  { code: 'AMD', name: 'Sardar Vallabhbhai Patel International Airport', city: 'Ahmedabad', country: 'India', timezone: 'Asia/Kolkata' },
  { code: 'COK', name: 'Cochin International Airport', city: 'Kochi', country: 'India', timezone: 'Asia/Kolkata' },
  { code: 'JAI', name: 'Jaipur International Airport', city: 'Jaipur', country: 'India', timezone: 'Asia/Kolkata' },
  { code: 'LKO', name: 'Chaudhary Charan Singh International Airport', city: 'Lucknow', country: 'India', timezone: 'Asia/Kolkata' }
];

export interface AircraftSpec {
  aircraftCode: string;
  model: string;
  layoutColumns: string;
  totalRows: number;
  businessRows: number;
}

/** 8 aircraft: A320neo x3 (180), A321neo x2 (222), B737-800 x2 (186), ATR 72 x1 (72). */
export const AIRCRAFT: AircraftSpec[] = [
  { aircraftCode: 'VT-SEA', model: 'A320neo', layoutColumns: 'ABC-DEF', totalRows: 30, businessRows: 2 },
  { aircraftCode: 'VT-SEB', model: 'A320neo', layoutColumns: 'ABC-DEF', totalRows: 30, businessRows: 2 },
  { aircraftCode: 'VT-SEC', model: 'A320neo', layoutColumns: 'ABC-DEF', totalRows: 30, businessRows: 2 },
  { aircraftCode: 'VT-SFA', model: 'A321neo', layoutColumns: 'ABC-DEF', totalRows: 37, businessRows: 2 },
  { aircraftCode: 'VT-SFB', model: 'A321neo', layoutColumns: 'ABC-DEF', totalRows: 37, businessRows: 2 },
  { aircraftCode: 'VT-SGA', model: 'B737-800', layoutColumns: 'ABC-DEF', totalRows: 31, businessRows: 2 },
  { aircraftCode: 'VT-SGB', model: 'B737-800', layoutColumns: 'ABC-DEF', totalRows: 31, businessRows: 2 },
  { aircraftCode: 'VT-SHA', model: 'ATR 72', layoutColumns: 'AC-DF', totalRows: 18, businessRows: 0 }
];

export const ATR_AIRCRAFT_CODE = 'VT-SHA';
export const JET_AIRCRAFT_CODES = AIRCRAFT.filter((a) => a.aircraftCode !== ATR_AIRCRAFT_CODE).map((a) => a.aircraftCode);

export interface RouteSpec {
  from: string;
  to: string;
  /** Airline prefix: AI, 6E, QP, SG or IX. */
  prefix: string;
  durationMinutes: number;
  /** Only these short routes may use the ATR 72. */
  short?: boolean;
}

/** ~20 directed routes (10 city pairs, both directions). Durations stay within 1h05m-3h. */
const PAIRS: Array<Omit<RouteSpec, 'from' | 'to'> & { a: string; b: string }> = [
  { a: 'BOM', b: 'DEL', prefix: 'AI', durationMinutes: 130 },
  { a: 'BOM', b: 'BLR', prefix: '6E', durationMinutes: 105 },
  { a: 'BOM', b: 'HYD', prefix: 'QP', durationMinutes: 95 },
  { a: 'BOM', b: 'GOI', prefix: 'SG', durationMinutes: 65, short: true },
  { a: 'BOM', b: 'PNQ', prefix: 'IX', durationMinutes: 65, short: true },
  { a: 'DEL', b: 'BLR', prefix: '6E', durationMinutes: 170 },
  { a: 'DEL', b: 'CCU', prefix: 'AI', durationMinutes: 135 },
  { a: 'BLR', b: 'COK', prefix: 'QP', durationMinutes: 70 },
  { a: 'HYD', b: 'MAA', prefix: 'SG', durationMinutes: 80 },
  { a: 'AMD', b: 'DEL', prefix: 'IX', durationMinutes: 100 }
];

export const ROUTES: RouteSpec[] = PAIRS.flatMap(({ a, b, ...rest }) => [
  { from: a, to: b, ...rest },
  { from: b, to: a, ...rest }
]);

export const DEMO_USERS = [1, 2, 3, 4, 5].map((n) => ({
  name: `Demo User ${n}`,
  email: `user${n}@example.com`,
  password: 'password123'
}));
