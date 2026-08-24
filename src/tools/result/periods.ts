import { TallyError } from '../../tally/TallyError.js';
import type { Company } from '../../tally/normalize.js';
import {
  bookYearFor,
  daysBetween,
  financialYearFor,
  todayIso,
  validateDateRange,
  type DateRange,
} from '../../utils/dates.js';
import { companyBookYear, companyNamed, type ToolDeps } from '../toolResult.js';

/**
 * Which period a tool covers, and what to say when the default one is empty.
 *
 * Moved out of toolResult.ts unchanged. Grouped together because they are one
 * question asked twice: what range did the caller actually get, and does the
 * emptiness of the answer mean "no data" or "wrong year". The second is the
 * single most common way a correct-looking empty result misleads a reader — see
 * `noteEmptyDefaultedPeriod`.
 */

/**
 * Resolve the period a tool should cover, defaulting to the COMPANY'S own year.
 *
 * Prefer this over the synchronous `resolvePeriod` in any tool that reads dated
 * data. The difference matters for every company that does not keep an Indian
 * April-to-March year:
 *
 * `resolvePeriod` defaults to `financialYearFor(today)`, which is hard-coded to
 * 1 April – 31 March. A US company on a calendar year, asked a question with no
 * dates, therefore gets a window straddling two of its own years — the second
 * half of one and the first half of the next — and every total is a blend of
 * two reporting periods with nothing saying so. The company this server is most
 * often pointed at is a US LLC, so this was the default in practice.
 *
 * `tally_check_tie_out` already did the right thing by hand; this makes the same
 * behaviour available to every tool instead of one.
 *
 * Costs nothing when dates ARE supplied: the company lookup happens only on the
 * defaulting path.
 */
export async function resolvePeriodForCompany(
  deps: ToolDeps,
  fromDate?: string,
  toDate?: string,
  /**
   * Whose book year to default to. Omitting it is safe only when ONE company is
   * loaded: the three companies seen live run a German calendar year, a US
   * April year and an Indian April year, so defaulting to "the first company"
   * would answer about the wrong twelve months without saying so.
   */
  company?: string
): Promise<DateRange> {
  // Explicit dates need no company at all — validate and return, no round trip.
  if (fromDate !== undefined || toDate !== undefined) {
    return resolvePeriod(fromDate, toDate);
  }

  // Falls back to the Indian year only when the company cannot be read, which
  // preserves the previous behaviour rather than failing the call.
  return (await companyBookYear(deps, company)) ?? financialYearFor(todayIso());
}

/**
 * Resolve the period a tool should cover, without consulting the company.
 *
 * Prefer `resolvePeriodForCompany`: this defaults to the Indian financial year
 * containing today, which is wrong for any company not on an April-to-March
 * year. Kept for the validation-only path and for callers that have already
 * resolved a default themselves.
 *
 * A single supplied date is an error, not something to half-guess: filling in
 * the other end silently would produce a period nobody asked for.
 */
export function resolvePeriod(fromDate?: string, toDate?: string): DateRange {
  if (fromDate === undefined && toDate === undefined) {
    return financialYearFor(todayIso());
  }
  if (fromDate === undefined || toDate === undefined) {
    throw new TallyError(
      'INVALID_DATE_RANGE',
      'Supply both fromDate and toDate, or neither. Given only one, the server will not guess the other end of the period.'
    );
  }
  return validateDateRange(fromDate, toDate);
}

/** True when the caller supplied no dates, so `resolvePeriod` picked the period. */
export function periodWasDefaulted(fromDate?: string, toDate?: string): boolean {
  return fromDate === undefined && toDate === undefined;
}

/**
 * Explain an empty result that came back for a period nobody asked for.
 *
 * A TallyPrime company is commonly created per financial year — "Acme (25-26)"
 * — while the default period here is the financial year containing *today*.
 * Open a prior-year company after 1 April and the two no longer overlap, so
 * every date-defaulted query returns zero rows. Observed live: a company with
 * 453 vouchers in its own year reported nothing at all, because the default
 * period had moved past the end of its books.
 *
 * Silence there is the dangerous outcome — "no vouchers" reads as *the data is
 * missing*, not *you asked about the wrong year*. So an empty result for a
 * period the caller never chose is annotated with the company's actual start
 * date and a concrete range to retry with.
 *
 * Deliberately narrow. It fires only when the period was defaulted AND the
 * result is empty, which is also the only path that pays for the extra company
 * lookup — a genuinely empty year still gets the note, which is honest, since
 * this says the period was defaulted rather than claiming it was wrong.
 */
export async function noteEmptyDefaultedPeriod(
  deps: ToolDeps,
  period: DateRange,
  wasDefaulted: boolean,
  resultCount: number,
  /** Which company the caller asked about, if any. */
  forCompany?: string
): Promise<string[]> {
  if (!wasDefaulted || resultCount > 0) return [];

  let company: Company | null;
  try {
    // By name where one was given. With several loaded and none named, there is
    // no company to describe, and naming the wrong one's book dates in a
    // diagnostic is how a user gets sent to check the wrong set of books.
    company = await companyNamed(deps, forCompany);
  } catch {
    // A diagnostic must never turn an empty-but-valid answer into a failure.
    return [];
  }

  if (company === null) return [];

  const books =
    company.startingFrom === null
      ? 'TallyPrime did not report when its books begin'
      : `its books begin ${company.startingFrom}`;

  const suggestion =
    company.startingFrom === null
      ? 'Supply fromDate and toDate covering the year you mean.'
      : (() => {
          // The company's own twelve-month year, anchored on the month its books
          // begin — not 1 April. Assuming April here produced a suggested range
          // that did not contain the company's data at all on a calendar-year
          // company, which is worse than making no suggestion.
          const year = bookYearFor(company.startingFrom, company.endingAt ?? company.startingFrom);
          return `Retry with fromDate ${year.fromDate} and toDate ${year.toDate} to cover that company's own book year.`;
        })();

  return [
    `No records for ${period.fromDate} to ${period.toDate} — a period you did not specify. ` +
      'With no dates given this server defaults to the financial year containing today, which ' +
      `may not be the year this company holds: the loaded company is "${company.name}" and ${books}. ` +
      `${suggestion} Do not report this as "no data" without checking the period first.`,
  ];
}

/**
 * Say when the period runs past the last date the company holds data for.
 *
 * `companyBookYear` is CORRECT and this does not change it: it returns the book
 * year CONTAINING `endingAt`, which is why a German calendar-year company gets
 * January-December and an Indian April-year company gets April-March. The gap
 * was never the arithmetic — it was that the resulting window can be almost
 * entirely empty and nothing said so.
 *
 * Found live 2026-08-18 on AgEx Pharma LLC, whose books end 2026-04-14. The
 * defaulted period resolved to 2026-04-01 – 2027-03-31: a full year, of which
 * FOURTEEN DAYS contain data. Every figure computed on it — a 100% gross
 * margin, a 1.08:1 current ratio, 1,131 receivable days — read as an annual
 * result and was quoted as one. None of them were wrong; all of them were
 * about a fortnight.
 *
 * Distinct from noteEmptyDefaultedPeriod, which fires only when the result is
 * EMPTY. This is the harder case: the result is full, plausible, and covers a
 * fraction of the window it claims. An empty answer prompts a second look; a
 * confident partial one does not.
 *
 * Fires whether or not the caller supplied the dates. An explicit period
 * running past the books is the same misreading — the caller may simply not
 * know where the books stop — and a warning is cheap next to an annualised
 * figure struck over two weeks.
 *
 * Never throws.
 */
export async function notePeriodBeyondBooks(
  deps: ToolDeps,
  period: DateRange,
  forCompany?: string
): Promise<string[]> {
  let company: Company | null;
  try {
    company = await companyNamed(deps, forCompany);
  } catch {
    return [];
  }

  if (company === null) return [];
  const endingAt = company.endingAt;
  if (endingAt === null) return [];

  // The books reach the end of the window: nothing to say.
  if (endingAt >= period.toDate) return [];
  // The window starts after the books stop. noteEmptyDefaultedPeriod owns the
  // empty case, and saying "0 of 365 days" alongside it would be noise.
  if (endingAt < period.fromDate) return [];

  const span = daysBetween(period.fromDate, period.toDate) + 1;
  const covered = daysBetween(period.fromDate, endingAt) + 1;
  if (span <= 0 || covered <= 0 || covered >= span) return [];

  const percent = ((covered / span) * 100).toFixed(0);

  return [
    `PARTIAL PERIOD. This period runs ${period.fromDate} to ${period.toDate}, but "${company.name}" ` +
      `holds no data after ${endingAt} — so only ${String(covered)} of ${String(span)} days ` +
      `(${percent}%) contain any transactions. The figures are real, and they are NOT a full ` +
      'period: any rate, ratio, margin or turnover struck on them describes the covered span ' +
      'only and must not be quoted as an annual result. Verified live on a company whose ' +
      'defaulted year contained fourteen days of trading and reported a 100% gross margin as a ' +
      `consequence. Either quote the figures as covering ${period.fromDate} to ${endingAt}, or ` +
      'check whether a later company holds the rest of the books.',
  ];
}
