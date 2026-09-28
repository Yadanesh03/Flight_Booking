/** Response DTOs (Architecture spec, Section 16). JSON everywhere; timestamps ISO-8601 UTC; money as strings. */
import type { FlightStatus } from './flights.js';
import type { PaymentMethod } from './booking.js';

export type Role = 'USER' | 'ADMIN';

export interface UserDto {
  id: number;
  name: string;
  email: string;
  role: Role;
}

export interface AirportDto {
  code: string;
  name: string;
  city: string;
  country: string;
  timezone: string;
}

export interface FlightSummaryDto {
  flightId: number;
  flightNumber: string;
  from: string;
  to: string;
  departureTime: string;
  arrivalTime: string;
  durationMinutes: number;
  aircraftModel: string;
  /** `base_price`. */
  fromPrice: string;
}

export interface FlightDetailDto extends FlightSummaryDto {
  status: FlightStatus;
  basePrice: string;
  currency: string;
  fromAirport: AirportDto;
  toAirport: AirportDto;
  aircraft: { model: string; layoutColumns: string; totalRows: number; businessRows: number; seatCount: number };
}

export interface AircraftDto {
  id: number;
  aircraftCode: string;
  model: string;
  layoutColumns: string;
  totalRows: number;
  businessRows: number;
  seatCount: number;
  createdAt: string;
}

export interface AdminFlightDto extends FlightSummaryDto {
  aircraftId: number;
  aircraftCode: string;
  status: FlightStatus;
  basePrice: string;
}

export type SeatStatus = 'AVAILABLE' | 'HELD' | 'HELD_BY_YOU' | 'BOOKED';
export type CabinClass = 'ECONOMY' | 'BUSINESS';
export type SeatType = 'WINDOW' | 'MIDDLE' | 'AISLE';

export interface SeatDto {
  seatId: number;
  seatNumber: string;
  row: number;
  column: string;
  cabinClass: CabinClass;
  seatType: SeatType;
  price: string;
  status: SeatStatus;
  holdExpiresAt?: string;
}

export interface SeatMapDto {
  flightId: number;
  serverTime: string;
  layout: { rows: number; columns: Array<string | null> };
  holdsUnavailable: boolean;
  seats: SeatDto[];
}

export interface HoldDto {
  flightId: number;
  seatId: number;
  seatNumber: string;
  expiresAt: string;
}

export interface HoldsResponse {
  holds: HoldDto[];
  serverTime: string;
}

export interface BookingSeatDto {
  seatId: number;
  seatNumber: string;
  price: string;
  passenger: { fullName: string; age: number };
}

export interface BookingFlightDto {
  flightId: number;
  flightNumber?: string;
  from?: string;
  to?: string;
  departureTime?: string;
  arrivalTime?: string;
}

export interface BookingDto {
  bookingRef: string;
  status: 'CONFIRMED' | 'FAILED';
  failureReason?: string;
  flight: BookingFlightDto;
  seats: BookingSeatDto[];
  totalAmount: string;
  currency: string;
  payment: { method: PaymentMethod; reference: string | null };
  confirmedAt: string | null;
  createdAt: string;
}

export interface BookingListResponse {
  items: BookingDto[];
  nextCursor: number | null;
}

export interface AdminInventoryDto {
  seatCount: number;
  booked: number;
  available: number;
  heldNow: number;
}
