import type { CabinClass, SeatType } from '@flight/shared';

export interface ParsedLayout {
  /** e.g. ['A','B','C',null,'D','E','F']; `null` is an aisle. Used verbatim by the seat map. */
  columns: Array<string | null>;
  /** Seat columns only, in order (aisles removed). */
  seatColumns: string[];
}

export interface GeneratedSeat {
  seatNumber: string;
  rowNo: number;
  columnCode: string;
  cabinClass: CabinClass;
  seatType: SeatType;
}

/** 'ABC-DEF' -> columns A B C (aisle) D E F. A dash is an aisle. */
export function parseLayout(layoutColumns: string): ParsedLayout {
  const columns: Array<string | null> = [];
  for (const ch of layoutColumns) columns.push(ch === '-' ? null : ch);
  return { columns, seatColumns: columns.filter((c): c is string => c !== null) };
}

/**
 * Seat type rules (Section 8.2): first and last column -> WINDOW; a column adjacent to an aisle ->
 * AISLE; otherwise MIDDLE. Window wins for a column that is both (e.g. a 2-column layout 'A-B').
 */
export function seatTypeFor(columns: Array<string | null>, seatColumn: string): SeatType {
  const seatColumns = columns.filter((c): c is string => c !== null);
  if (seatColumn === seatColumns[0] || seatColumn === seatColumns[seatColumns.length - 1]) return 'WINDOW';
  const index = columns.indexOf(seatColumn);
  if (columns[index - 1] === null || columns[index + 1] === null) return 'AISLE';
  return 'MIDDLE';
}

/**
 * Generates every seat of an aircraft. Rows 1..businessRows are BUSINESS, the rest ECONOMY.
 * `seat_count` is always rows x columns and is computed by the caller from this result's length,
 * never taken from input.
 */
export function generateSeats(layoutColumns: string, totalRows: number, businessRows: number): GeneratedSeat[] {
  const { columns, seatColumns } = parseLayout(layoutColumns);
  const typeByColumn = new Map(seatColumns.map((column) => [column, seatTypeFor(columns, column)] as const));
  const seats: GeneratedSeat[] = [];
  for (let row = 1; row <= totalRows; row += 1) {
    for (const column of seatColumns) {
      seats.push({
        seatNumber: `${row}${column}`,
        rowNo: row,
        columnCode: column,
        cabinClass: row <= businessRows ? 'BUSINESS' : 'ECONOMY',
        seatType: typeByColumn.get(column) as SeatType
      });
    }
  }
  return seats;
}
