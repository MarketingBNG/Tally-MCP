import { TallyError } from '../tally/TallyError.js';

/**
 * Date handling.
 *
 * Dates in this project are **naive local dates** — a calendar day as an
 * accountant means it, with no timezone component. We never construct a
 * Date object from user input for conversion purposes, because that would
 * introduce a UTC offset and can shift a voucher across a day boundary
 * (and therefore across a financial year). All conversion is string-level.
 *
 * Wire format: Tally uses `YYYYMMDD`. MCP tool inputs use ISO `YYYY-MM-DD`.
 */

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface DateRange {
  fromDate: string;
  toDate: string;
}

/** True if the ISO date string denotes a real calendar day. */
export function isValidIsoDate(value: string): boolean {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  return true;
}

function daysInMonth(year: number, month: number): number {
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1] ?? 0;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** ISO `YYYY-MM-DD` to Tally's `YYYYMMDD`. Assumes an already-validated input. */
export function isoToTallyDate(iso: string): string {
  return iso.replace(/-/g, '');
}

/** Tally's `YYYYMMDD` to ISO `YYYY-MM-DD`. Returns null if unparseable. */
export function tallyDateToIso(tally: string): string | null {
  const trimmed = tally.trim();
  if (!/^\d{8}$/.test(trimmed)) return null;
  const iso = `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
  return isValidIsoDate(iso) ? iso : null;
}

/**
 * Validate a date range supplied by a tool caller.
 * Throws INVALID_DATE_RANGE with a message naming the offending value.
 */
export function validateDateRange(fromDate: string, toDate: string): DateRange {
  if (!isValidIsoDate(fromDate)) {
    throw new TallyError(
      'INVALID_DATE_RANGE',
      `fromDate "${fromDate}" is not a valid date. Use ISO format YYYY-MM-DD.`
    );
  }
  if (!isValidIsoDate(toDate)) {
    throw new TallyError(
      'INVALID_DATE_RANGE',
      `toDate "${toDate}" is not a valid date. Use ISO format YYYY-MM-DD.`
    );
  }
  // Safe as plain string comparison: zero-padded ISO dates sort chronologically.
  if (fromDate > toDate) {
    throw new TallyError(
      'INVALID_DATE_RANGE',
      `fromDate (${fromDate}) must be on or before toDate (${toDate}).`
    );
  }
  return { fromDate, toDate };
}

/**
 * Indian financial year containing the given date: 1 April to 31 March.
 *
 * Used when a tool is called with no date range, matching what TallyPrime's
 * own reports default to. The resolved range is echoed back in the response
 * so Claude knows which period it actually received rather than assuming.
 */
export function financialYearFor(isoDate: string): DateRange {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const startYear = month >= 4 ? year : year - 1;
  return {
    fromDate: `${String(startYear)}-04-01`,
    toDate: `${String(startYear + 1)}-03-31`,
  };
}

/** Today as a naive local ISO date, using the host's local calendar. */
export function todayIso(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(year)}-${month}-${day}`;
}
