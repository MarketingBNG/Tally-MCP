

import {
  UNSCOPED,
} from '../../tally/requests.js';

import {
  assertCompanyIsLoaded,
  resolveCompanyCurrency,
  companyNamed,
  notePeriodBeyondBooks,
  resolvePeriodForCompany,
  type ToolDeps,
} from '../toolResult.js';
import {
  bookYearFor,
  endDateBinds as endDateIsHonoured,
  nearestBindingEndDate,
  todayIso,
  validateDateRange,
  type DateRange,
} from '../../utils/dates.js';

import {
  compareStatements,
  type RowFigures,
} from '../statementComparison.js';
import {
  TallyError,
} from '../../tally/TallyError.js';
import {
  STATEMENTS,
  statementEndDateIsIgnored,
  type StatementKey,
} from './specs.js';
import {
  noteCostRecoveriesInRevenue,
  noteMastersDivergence,
  noteStaleClosingStock,
} from './diagnostics.js';

/**
 * Running ONE statement, and the period arithmetic a comparison needs.
 *
 * `executeStatement` is the path every other runner goes through, so it owns the
 * end-date honouring check, the diagnostics and the currency resolution. See
 * ./series.ts for the loops that call it repeatedly.
 */

/**
 * The date these reports accumulate TO when the requested end date is ignored,
 * or null when it cannot be read.
 *
 * This is the end of the loaded company's own book year — twelve months anchored
 * on the month and day its books begin, containing the last date it holds data
 * for. Derived from the company's own `startingFrom` and `endingAt` rather than
 * from an assumed 1 April, because Tally imposes no such year: verified live
 * 2026-08-14 against a German company whose books run January to December, where
 * assuming April produced an end date EARLIER than the start of the requested
 * period and put that inverted range in a user-facing warning.
 *
 * `endingAt` anchors it rather than today's date. A company holding 2019 books
 * does not become a 2026 company because someone opened it today, and the figure
 * this feeds is a claim about what Tally actually returned.
 *
 * Never throws: this is a guard, and a guard that turns a working call into an
 * error because a metadata lookup failed is worse than the thing it guards
 * against. A null means "could not check", which is reported as such.
 */
async function companyAccumulationEnd(
  deps: ToolDeps,
  /**
   * Which company's endpoint. Required in practice with several loaded: this
   * feeds a WARNING about how far the figures really run, and quoting one
   * company's endpoint against another's statement would make the correction
   * itself wrong.
   */
  company?: string
): Promise<string | null> {
  try {
    const record = await companyNamed(deps, company);
    if (record === null) return null;
    const start = record.startingFrom ?? null;
    if (start === null) return null;
    return bookYearFor(start, record.endingAt ?? todayIso()).toDate;
  } catch {
    return null;
  }
}

/**
 * Resolve the optional comparison period.
 *
 * Unlike the main period this is never defaulted. A comparison is only
 * meaningful against a period the caller chose, and quietly picking "the
 * previous year" would put a period nobody asked for on the other side of every
 * subtraction — the same failure this codebase avoids by echoing the resolved
 * range everywhere else.
 */
function resolveComparisonPeriod(
  compareFromDate?: string,
  compareToDate?: string
): { fromDate: string; toDate: string } | undefined {
  if (compareFromDate === undefined && compareToDate === undefined) return undefined;
  if (compareFromDate === undefined || compareToDate === undefined) {
    throw new TallyError(
      'INVALID_DATE_RANGE',
      'Supply both compareFromDate and compareToDate, or neither. Given only one, the server will not guess the other end of the comparison period.'
    );
  }
  return validateDateRange(compareFromDate, compareToDate);
}

/**
 * What one statement run produced, before anything is shaped for a caller.
 *
 * `tally_get_statement` renders this; the scheduled workbook export writes it
 * to a sheet. Extracted for exactly the reason `executeVoucherTest` was — see
 * workpaper.ts — so a second reader of the same statement cannot end up with a
 * second, quietly divergent idea of what the period covers or which warnings
 * apply to it.
 */
export interface ExecutedStatement {
  statement: StatementKey;
  period: DateRange;
  /** False when TallyPrime ignored the end date and the figures run past it. */
  coversPeriodRequested: boolean;
  /**
   * Where the figures actually stop when the end date did not bind — `toDate`
   * null when even that could not be established. Null when the period bound,
   * in which case `period` is already the answer.
   */
  figuresActuallyCover: { fromDate: string; toDate: string | null } | null;
  rows: unknown[];
  warnings: string[];
  comparison: {
    period: DateRange;
    rows: unknown[];
    changes: unknown[];
    unpaired: unknown;
  } | null;
  /** Reads the figures off one row, for a caller that wants to drop nil rows. */
  figuresOf: (row: unknown) => RowFigures;
}

/**
 * Run one statement for one company, with an optional comparison period.
 *
 * Every caveat this statement carries comes back in `warnings`, in the order
 * the tool has always emitted them. A caller must not drop them: the end-date
 * rule and the trial balance's stock-at-opening divergence are the two things
 * standing between these rows and a confident wrong figure.
 */
export async function executeStatement(
  deps: ToolDeps,
  statement: StatementKey,
  args: {
    company?: string | undefined;
    fromDate?: string | undefined;
    toDate?: string | undefined;
    compareFromDate?: string | undefined;
    compareToDate?: string | undefined;
    /**
     * Skip the checks that compare this statement against the company's CURRENT
     * state — the masters divergence, the stale closing stock, the cost
     * recoveries in revenue.
     *
     * Set this for a HISTORICAL year, and only for one. Those checks read the
     * ledger masters and the stock summary as they are TODAY; against a prior
     * year they do not merely waste three requests, they produce a warning that
     * is actively wrong — "the trial balance says 6.3m and the ledgers say 44.5m"
     * is a true sentence about two different periods and a misleading one about
     * either. They also cost a full ledger and group fetch per year, which over
     * five years is most of the time the series takes.
     */
    skipCurrentStateChecks?: boolean;
  }
): Promise<ExecutedStatement> {
  const spec = STATEMENTS[statement];
  const period = await resolvePeriodForCompany(deps, args.fromDate, args.toDate, args.company);
  const comparisonPeriod = resolveComparisonPeriod(args.compareFromDate, args.compareToDate);
  // Tally's own spelling, not the caller's. Measured 14 Aug 2026: matching is
  // case-insensitive and whitespace-tolerant, and an unmatched name returns an
  // EMPTY report — so the point of canonicalising is a truthful company_id and
  // rejecting an unknown name before it becomes a misleading empty answer.
  const company = await assertCompanyIsLoaded(deps, args.company);
  const currencyWarnings: string[] = [];
  const currency = await resolveCompanyCurrency(deps, company, currencyWarnings);

  const fetchFor = async (range: { fromDate: string; toDate: string }) => {
    const request = spec.build({
      company: company ?? UNSCOPED,
      fromDate: range.fromDate,
      toDate: range.toDate,
      format: deps.config.tallyPreferredFormat,
    });

    // Statements are report-class: they get the longer timeout.
    const response = await deps.client.send(request, 'report');
    const { data, warnings } = spec.normalize(response.body, currency);
    return { rows: data, warnings: [...response.repairs, ...currencyWarnings, ...warnings] };
  };

  // Whether Tally will honour each end date. This is a property of the
  // DATE, not of the company — see statementEndDateIsIgnored above — so it
  // is decided locally and costs nothing. The company lookup below is only
  // needed to say what the figures cover when it does not bind.
  const endDateBinds = endDateIsHonoured(period.toDate);
  const comparisonEndBinds =
    comparisonPeriod === undefined || endDateIsHonoured(comparisonPeriod.toDate);

  // Checked before any comparison is attempted, because the failure mode
  // is a fabricated movement rather than a visibly wrong figure. BOTH
  // sides must bind: one honoured period minus one that silently ran to
  // the year end is the same fabrication, half the time.
  if (comparisonPeriod !== undefined && !(endDateBinds && comparisonEndBinds)) {
    const offending = !endDateBinds ? period.toDate : comparisonPeriod.toDate;
    const suggested = nearestBindingEndDate(offending);
    throw new TallyError(
      'TALLY_UNSUPPORTED_OPERATION',
      `Period comparison cannot be answered: ${statementEndDateIsIgnored(offending)} That period would therefore run past the end date asked for, and subtracting two such periods yields minus the whole of the earlier one rather than the movement between them — a wrong figure of plausible size.`,
      {
        suggestion:
          suggested === null
            ? 'Move both end dates onto the 31st of a month — 31 January, 31 March, 31 May, 31 July, 31 August, 31 October or 31 December — and this comparison will be answered. For a period that genuinely ends mid-month, use tally_get_vouchers or tally_summarise_movements, whose date ranges are honoured to the day.'
            : `Use ${suggested} instead of ${offending} (and likewise for the other period, if it does not end on a 31st) and this comparison will be answered. For a period that genuinely must end on ${offending}, use tally_get_vouchers or tally_summarise_movements, whose date ranges are honoured to the day.`,
        context: {
          requested: period,
          comparison: comparisonPeriod,
          endDatesHonoured: { period: endDateBinds, comparison: comparisonEndBinds },
        },
      }
    );
  }

  // Only paid for when it is needed: the figures bound correctly, so there
  // is nothing to explain and no reason to spend a request on the company.
  const periodEnd = endDateBinds ? null : await companyAccumulationEnd(deps, args.company);

  const current = await fetchFor(period);

  // Trial balance only. It is the statement whose rows ARE the top-level
  // groups and the one read as "the books", so a silent disagreement
  // with the ledger list does the most damage there. balance_sheet was
  // checked live against the same masters and agreed to the cent on
  // every group, so it is not paid for on that path.
  const divergenceWarnings = args.skipCurrentStateChecks === true
    ? []
    : statement === 'trial_balance'
      ? await noteMastersDivergence(deps, args.company, current.rows)
      : statement === 'profit_loss'
        ? [
            ...(await noteStaleClosingStock(deps, args.company, current.rows)),
            ...(await noteCostRecoveriesInRevenue(deps, args.company)),
          ]
        : [];

  // Only where the end date bound. Where it did not, the figures already
  // ran past the requested period and periodWarnings says so at length —
  // adding "and the books stop earlier" on top would describe a window
  // that is not the one the figures cover.
  const partialPeriodWarnings = endDateBinds
    ? await notePeriodBeyondBooks(deps, period, args.company)
    : [];

  // A single period is still answered — the figures are real, they simply
  // cover a period the caller did not ask for. Refusing outright would
  // withhold correct data; saying nothing would let it be quoted as the
  // period requested. So it is answered, loudly annotated.
  const periodWarnings = endDateBinds
    ? []
    : [
        `${statementEndDateIsIgnored(period.toDate)} These figures therefore cover ` +
          `${period.fromDate} to ` +
          `${periodEnd === null ? "the end of the company's own book year" : periodEnd}, NOT ` +
          `${period.toDate} as requested. Quote them as a cumulative position from ` +
          `${period.fromDate}, and do NOT describe them as the figures for the requested ` +
          'period. ' +
          (nearestBindingEndDate(period.toDate) === null
            ? 'To bound the period, move the end date to the 31st of a month, or use tally_get_vouchers, whose date range TallyPrime honours to the day.'
            : `To get a period that really ends where you asked, retry with toDate ${nearestBindingEndDate(period.toDate) ?? ''}, or use tally_get_vouchers, whose date range TallyPrime honours to the day.`),
      ];

  const base = {
    statement,
    period,
    coversPeriodRequested: endDateBinds,
    figuresActuallyCover: endDateBinds
      ? null
      : { fromDate: period.fromDate, toDate: periodEnd },
    rows: current.rows,
    figuresOf: spec.compare.figuresOf,
  };

  if (comparisonPeriod === undefined) {
    return {
      ...base,
      warnings: [
        ...periodWarnings,
        ...partialPeriodWarnings,
        ...divergenceWarnings,
        ...current.warnings,
      ],
      comparison: null,
    };
  }

  // Sequential, not parallel: Tally's listener serves one request at a
  // time and the client queue would serialise these anyway. Awaiting in
  // order keeps the failure attributable to a period.
  const comparison = await fetchFor(comparisonPeriod);
  const compared = compareStatements(current.rows, comparison.rows, spec.compare);

  return {
    ...base,
    warnings: [
      ...periodWarnings,
      ...partialPeriodWarnings,
      ...divergenceWarnings,
      ...current.warnings,
      ...comparison.warnings,
      ...compared.warnings,
    ],
    comparison: {
      period: comparisonPeriod,
      rows: comparison.rows,
      changes: compared.changes,
      unpaired: compared.unpaired,
    },
  };
}
