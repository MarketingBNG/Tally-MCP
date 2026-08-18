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
 * Tally's `UPDATEDDATETIME` to an ISO local timestamp, or null.
 *
 * The wire format is `YYYYMMDDHHMMSSmmm` — 17 digits, verified live 2026-08-18
 * across 668 vouchers on two companies (docs/probe-findings-2026-08-18.md).
 *
 * NULL IS THE IMPORTANT RETURN VALUE. On a company that does not stamp its
 * vouchers the field arrives as all zeros rather than absent, and an all-zero
 * value parsed leniently becomes a date in year 0 — which would then sort as
 * "written long before the voucher" and read as the opposite of what it means.
 * So a placeholder is rejected outright, and every caller has to decide what to
 * do about an unstamped voucher rather than being handed a fabricated instant.
 *
 * NO TIMEZONE is offered, because Tally does not record one: the stamp is the
 * local clock of the machine that wrote the voucher. Returning a `Z` suffix would
 * assert UTC and silently shift every timestamp by the client's offset.
 */
export function tallyDateTimeToIso(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d{14,17}$/.test(trimmed)) return null;
  // All zeros — Tally's "never stamped" placeholder.
  if (/^0+$/.test(trimmed)) return null;

  const date = tallyDateToIso(trimmed.slice(0, 8));
  if (date === null) return null;

  const hour = Number(trimmed.slice(8, 10));
  const minute = Number(trimmed.slice(10, 12));
  const second = Number(trimmed.slice(12, 14));
  if (hour > 23 || minute > 59 || second > 59) return null;

  return `${date}T${trimmed.slice(8, 10)}:${trimmed.slice(10, 12)}:${trimmed.slice(12, 14)}`;
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
 *
 * ONLY a fallback for when the company's own start date is unknown. Anywhere a
 * company has been read, use `bookYearFor` instead: this function bakes in
 * 1 April, which is right for an Indian company and wrong for every other kind.
 * Verified live 2026-08-14 against a German GmbH whose books run January to
 * December — this returned a year that did not even contain the company's start
 * date, and fed an inverted range into a user-facing warning.
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

/** ISO date built from parts, normalising overflow (2025-02-29 becomes 2025-03-01). */
function isoFromParts(year: number, month: number, day: number): string {
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getUTCFullYear())}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/**
 * The company's own twelve-month book year containing `onIso`.
 *
 * TallyPrime does not impose the Indian April–March year. A company's year is
 * twelve months anchored on the month and day its books begin: an Indian
 * company starting 1 April runs to 31 March, a German or calendar-year company
 * starting 1 January runs to 31 December. This derives the window from the
 * company's OWN start date rather than assuming one.
 *
 * Verified live 2026-08-14 against AGBV Nutrition GmbH (books from 2023-01-01,
 * data to 2026-07-31): `bookYearFor('2023-01-01', '2026-07-31')` gives
 * 2026-01-01 to 2026-12-31, and a Cash Flow request that Tally accumulated to
 * its year end returned exactly the months up to December 2026 — the last five
 * of them empty, because the data stops in July. `financialYearFor` would have
 * said 31 March, and the warning built on it told the user the figures covered
 * a date BEFORE the period they asked about.
 *
 * `onIso` should be the company's `endingAt` where Tally reports one, not
 * today's date: a company holding 2019 books does not become a 2026 company
 * because someone opened it today.
 */
export function bookYearFor(startIso: string, onIso: string): DateRange {
  const anchorMonth = Number(startIso.slice(5, 7));
  const anchorDay = Number(startIso.slice(8, 10));

  // The anchor falling in the same year as `onIso`. If `onIso` is earlier than
  // that, the containing window opened the year before.
  const sameYear = isoFromParts(Number(onIso.slice(0, 4)), anchorMonth, anchorDay);
  const startYear = onIso >= sameYear ? Number(onIso.slice(0, 4)) : Number(onIso.slice(0, 4)) - 1;

  const fromDate = isoFromParts(startYear, anchorMonth, anchorDay);
  // A year on, less a day. Going through Date.UTC handles a 29 February anchor
  // without a special case: 2024-02-29 plus a year normalises to 2025-03-01,
  // and stepping back a day gives 2025-02-28.
  const toDate = isoFromParts(startYear + 1, anchorMonth, anchorDay - 1);

  return { fromDate, toDate };
}

/**
 * Whether TallyPrime will honour this date as the END of a statement period.
 *
 * It does so only when the day of the month is the 31st. Any other day — including
 * a genuine month end like 30 November — is ignored, and the report accumulates
 * from `fromDate` to the end of the company's book year instead.
 *
 * This is an empirical rule, established by sweeping `SVTODATE` against a live
 * TallyPrime with the cache off (`scripts/probe-todate-binding.ts`, 2026-08-14).
 * Nineteen observations, no exceptions: 31 January, 31 March, 31 May, 31 July,
 * 31 August and 31 December all returned exactly the months requested, while
 * 29 February, 15 March, 30 March, 30 April, 30 June, 30 September and
 * 30 November all returned the whole book year. 30 November is the case that
 * rules out "the last day of the month" as the explanation.
 *
 * It also explains the earlier finding that the end date was ignored ALTOGETHER:
 * every span tested then ended on a calendar quarter end, and three of the four
 * quarter ends fall on the 30th.
 *
 * The mechanism inside TallyPrime is unknown and not guessed at here. What is
 * verified is the behaviour, and the behaviour is what callers must be told.
 */
export function endDateBinds(isoDate: string): boolean {
  return isoDate.slice(8, 10) === '31';
}

/**
 * The nearest date on or before `isoDate` that TallyPrime would honour, or null
 * when there is none in the same month. Used to suggest a workable period
 * instead of only refusing one.
 */
export function nearestBindingEndDate(isoDate: string): string | null {
  if (endDateBinds(isoDate)) return isoDate;
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  // Step back to the previous month's 31st, which exists only if that month has one.
  const previousMonth = month === 1 ? 12 : month - 1;
  const previousYear = month === 1 ? year - 1 : year;
  return daysInMonth(previousYear, previousMonth) === 31
    ? `${String(previousYear)}-${String(previousMonth).padStart(2, '0')}-31`
    : null;
}

/**
 * Whole days from `fromIso` to `toIso`. Negative when `toIso` is earlier.
 *
 * Built on `Date.UTC` from the date parts rather than by parsing the strings.
 * Parsing would attach the host's timezone and can shift a day boundary — and a
 * day boundary here is the difference between a bill ageing into the next
 * bucket or not. Fixing both ends to UTC midnight makes the subtraction exact
 * for calendar days, including across DST changes, without either date
 * acquiring a timezone it does not have.
 */
export function daysBetween(fromIso: string, toIso: string): number {
  const utc = (iso: string): number =>
    Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

  const MS_PER_DAY = 86_400_000;
  return Math.round((utc(toIso) - utc(fromIso)) / MS_PER_DAY);
}

/** Today as a naive local ISO date, using the host's local calendar. */
export function todayIso(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(year)}-${month}-${day}`;
}

/**
 * A date shifted by whole days, in ISO form.
 *
 * Used to step from the last day of one book year into the first of the next.
 * Goes through `Date.UTC` so month and year boundaries — and leap days — are
 * handled by the calendar rather than by arithmetic on the parts.
 */
export function addDaysIso(iso: string, days: number): string {
  const shifted = new Date(
    Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) +
      days * 86_400_000
  );
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${String(shifted.getUTCFullYear())}-${month}-${day}`;
}
