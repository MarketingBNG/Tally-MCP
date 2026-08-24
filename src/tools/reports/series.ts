

import {
  UNSCOPED,
} from '../../tally/requests.js';

import {
  assertCompanyIsLoaded,
  resolveCompanyCurrency,
  resolveCompanyCurrencyDetailed,
  whole,
  type ToolDeps,
  type ToolBodyResult,
} from '../toolResult.js';
import {
  endDateBinds as endDateIsHonoured,
  nearestBindingEndDate,
  validateDateRange,
  type DateRange,
} from '../../utils/dates.js';

import {
  buildTrend,
} from '../statementComparison.js';
import {
  TallyError,
} from '../../tally/TallyError.js';
import { STATEMENTS, statementEndDateIsIgnored, type StatementKey } from './specs.js';

/**
 * Running a statement repeatedly: a trend across periods, or the same statement
 * across companies.
 *
 * Both loops are deliberately SEQUENTIAL. Tally's listener serves one request at
 * a time (see requestQueue.ts), so concurrency buys nothing here, and running
 * them in order is what makes a failure attributable to the period or company
 * that caused it rather than to the batch.
 */

/**
 * Run one statement across several periods.
 *
 * ## Why every period end date must fall on a 31st
 *
 * TallyPrime honours a statement's end date ONLY when it lands on the 31st of a
 * month, and ignores it on every other day — including real month ends such as
 * 30 November. When ignored, the figures accumulate from the start date to the
 * end of the last book year the company holds. Measured live: on a company whose
 * books run 2021-04-01 to 2026-07-28, every request from any start date ran to
 * 2027-03-31.
 *
 * A single statement can still be answered under that condition, loudly
 * annotated, because the figures are real and merely cover a different span. A
 * TREND cannot. Every period would silently share the same endpoint, so the
 * series would be a run of cumulative positions that differ only by their start
 * date — and the movements between them would be differences between two
 * overlapping accumulations rather than the change from one period to the next.
 * That is a wrong figure of entirely plausible size, in the output most likely
 * to be read as a shape and quoted without its caveats.
 *
 * So this refuses, names every offending period, and suggests the nearest date
 * that does bind. Consistent with the two-period comparison, which refuses for
 * the same reason.
 */
export async function runTrend(
  deps: ToolDeps,
  statement: StatementKey,
  periods: readonly { fromDate: string; toDate: string }[],
  companyArg: string | undefined
): Promise<ToolBodyResult> {
  const spec = STATEMENTS[statement];

  // Validated before anything is fetched: a trend is N report-class requests,
  // and rejecting bad input must never cost them.
  const ranges = periods.map((range) => validateDateRange(range.fromDate, range.toDate));

  const offending = ranges.filter((range) => !endDateIsHonoured(range.toDate));
  if (offending.length > 0) {
    const suggestions = offending
      .map((range) => {
        const nearest = nearestBindingEndDate(range.toDate);
        return nearest === null ? `${range.toDate} (no nearby 31st)` : `${range.toDate} → ${nearest}`;
      })
      .join('; ');

    throw new TallyError(
      'TALLY_UNSUPPORTED_OPERATION',
      `A trend cannot be answered: ${String(offending.length)} of the ${String(ranges.length)} ` +
        `periods end on a date TallyPrime will not honour. ${statementEndDateIsIgnored(offending[0]?.toDate ?? '')} ` +
        'Every period would therefore accumulate to the same endpoint, so the series would show ' +
        'cumulative positions differing only by start date, and the movements between them would ' +
        'be differences between overlapping accumulations rather than period-to-period change.',
      {
        suggestion:
          `Move each end date onto the 31st of a month — ${suggestions}. Only 31 January, 31 ` +
          'March, 31 May, 31 July, 31 August, 31 October and 31 December bind. For periods that ' +
          'genuinely end mid-month, use tally_summarise_movements with groupBy "month", whose ' +
          'date ranges TallyPrime honours to the day.',
        context: { periods: ranges },
      }
    );
  }

  const company = await assertCompanyIsLoaded(deps, companyArg);
  const currencyWarnings: string[] = [];
  const currency = await resolveCompanyCurrency(deps, company, currencyWarnings);

  // Sequential, not parallel: Tally serves one request at a time and the client
  // queue would serialise these anyway. Awaiting in order keeps a failure
  // attributable to the period that caused it.
  const fetched: { period: DateRange; rows: unknown[]; warnings: string[] }[] = [];
  for (const range of ranges) {
    const response = await deps.client.send(
      spec.build({
        company: company ?? UNSCOPED,
        fromDate: range.fromDate,
        toDate: range.toDate,
        format: deps.config.tallyPreferredFormat,
      }),
      'report'
    );
    const { data, warnings } = spec.normalize(response.body, currency);
    fetched.push({ period: range, rows: data, warnings: [...response.repairs, ...warnings] });
  }

  const trend = buildTrend(
    fetched.map((entry) => entry.rows),
    spec.compare
  );

  const warnings = [
    ...currencyWarnings,
    ...trend.warnings,
    ...fetched.flatMap((entry) => entry.warnings),
    'Movements are in TallyPrime own sign convention on both sides, so a movement is a change ' +
      'in Tally encoding and NOT a plain-English increase: a debit balance growing larger becomes ' +
      'more negative. Say which direction a figure moved in Tally terms rather than calling it a ' +
      'rise or a fall.',
  ];

  return whole(
    {
      statement,
      periods: ranges,
      coversPeriodRequested: true,
      ...(companyArg === undefined ? {} : { company: companyArg }),
      trend: { rows: trend.rows, unpaired: trend.unpaired },
      warnings,
    },
    trend.rows.length
  );
}

/**
 * Run one statement across several companies, side by side.
 *
 * ## The three things that make this different from a trend
 *
 * **The period cannot be defaulted.** Each company's default period is its own
 * book year, and the three seen live run a German calendar year and two April
 * years. Defaulting would compare different months under one heading, which is
 * the kind of wrong that never announces itself. So explicit dates are required.
 *
 * **No differences are computed across currencies.** Of the companies observed
 * live one reports `$` and two report a symbol TallyPrime could not transport at
 * all. Subtracting one company's figure from another's would produce a number
 * that looks exactly like a movement and means nothing. The rows are still
 * paired — seeing Sales for three companies side by side is the point — but the
 * subtraction is omitted, and the response says why.
 *
 * **Every company must be open in TallyPrime.** Each is checked against the
 * loaded list BEFORE any figures are fetched, because an unmatched name returns
 * an empty report rather than an error, and an empty column in a comparison
 * reads as "this company had none of that".
 */
export async function runMultiCompany(
  deps: ToolDeps,
  statement: StatementKey,
  companies: readonly string[],
  fromDate: string | undefined,
  toDate: string | undefined
): Promise<ToolBodyResult> {
  const spec = STATEMENTS[statement];

  if (fromDate === undefined || toDate === undefined) {
    throw new TallyError(
      'INVALID_DATE_RANGE',
      'Comparing companies needs an explicit fromDate and toDate.',
      {
        suggestion:
          'The companies keep different book years — a calendar year and an April year sit side ' +
          'by side on a typical install — so there is no shared period to default to, and ' +
          'picking one of their years would compare different months under one heading. Name ' +
          'the period you want all of them read over.',
      }
    );
  }

  const period = validateDateRange(fromDate, toDate);

  if (!endDateIsHonoured(period.toDate)) {
    const nearest = nearestBindingEndDate(period.toDate);
    throw new TallyError(
      'TALLY_UNSUPPORTED_OPERATION',
      `Companies cannot be compared over this period: ${statementEndDateIsIgnored(period.toDate)} ` +
        'Each company would accumulate to the end of ITS OWN last book year, and those differ ' +
        'between them — so the columns would cover different spans while appearing to cover one.',
      {
        suggestion:
          nearest === null
            ? 'Use an end date on the 31st of a month — 31 January, March, May, July, August, October or December.'
            : `Use ${nearest} instead of ${period.toDate}.`,
      }
    );
  }

  // Duplicates would render one company twice and make any "the figures differ"
  // check pass for the wrong reason.
  const seen = new Set<string>();
  for (const name of companies) {
    const key = name.trim().toLowerCase();
    if (seen.has(key)) {
      throw new TallyError('INVALID_PARAMETERS', `Company "${name}" is listed more than once.`);
    }
    seen.add(key);
  }

  // Every name resolved BEFORE any figures are fetched: an unmatched name
  // returns an empty report, and an empty column reads as "this company had
  // none of that" rather than as a mistake.
  const canonical: string[] = [];
  for (const name of companies) {
    const resolved = await assertCompanyIsLoaded(deps, name);
    if (resolved === undefined) {
      throw new TallyError('TALLY_COMPANY_NOT_LOADED', `Could not resolve the company "${name}".`);
    }
    canonical.push(resolved);
  }

  // Sequential: Tally serves one request at a time, and awaiting in order keeps
  // a failure attributable to the company that caused it.
  const fetched: {
    company: string;
    currency: string;
    comparable: boolean;
    rows: unknown[];
    warnings: string[];
  }[] = [];
  for (const company of canonical) {
    const currencyWarnings: string[] = [];
    const resolved = await resolveCompanyCurrencyDetailed(deps, company, currencyWarnings);
    const response = await deps.client.send(
      spec.build({
        company,
        fromDate: period.fromDate,
        toDate: period.toDate,
        format: deps.config.tallyPreferredFormat,
      }),
      'report'
    );
    const { data, warnings } = spec.normalize(response.body, resolved.label);
    fetched.push({
      company,
      currency: resolved.label,
      comparable: resolved.comparable,
      rows: data,
      warnings: [...response.repairs, ...currencyWarnings, ...warnings],
    });
  }

  const currencies = new Set(fetched.map((entry) => entry.currency));
  // Matching LABELS are not enough. A label that was inferred from the
  // company's country, or that stands in for a symbol Tally could not
  // transport, can be identical across two companies whose books are in
  // genuinely different currencies — so subtracting would produce a wrong
  // figure of plausible size. Differences are computed only when every
  // company's currency was actually established (by Tally or by
  // configuration) AND they all agree.
  const everyCurrencyEstablished = fetched.every((entry) => entry.comparable);
  const oneCurrency = currencies.size === 1 && everyCurrencyEstablished;

  const paired = buildTrend(
    fetched.map((entry) => entry.rows),
    spec.compare,
    { movements: oneCurrency }
  );

  const warnings = [
    ...paired.warnings,
    ...fetched.flatMap((entry) => entry.warnings),
    `Columns are in the order the companies were given: ${canonical.join(', ')}. Each row's ` +
      '`presentIn` indexes into that order, so a gap names a company rather than a position.',
  ];

  if (oneCurrency) {
    warnings.push(
      `All ${String(fetched.length)} companies report in ${[...currencies][0] ?? ''}, so ` +
        'differences between adjacent columns are computed. They are still differences between ' +
        'separate legal entities, not a movement over time — do not describe them as a change.'
    );
  } else if (!everyCurrencyEstablished) {
    const unestablished = fetched
      .filter((entry) => !entry.comparable)
      .map((entry) => `${entry.company} (labelled "${entry.currency}")`)
      .join(', ');
    warnings.push(
      'NO DIFFERENCES BETWEEN COMPANIES ARE COMPUTED, because at least one currency was not ' +
        `established by TallyPrime or by configuration: ${unestablished}. A label that was ` +
        'inferred, or that stands in for a symbol TallyPrime could not transport, can match ' +
        'another company\'s label while the books are in a different currency — so subtracting ' +
        'could silently mix currencies and produce a wrong figure of plausible size. Compare ' +
        'them by reading the columns, not by taking differences, and never total the row. Set ' +
        'TALLY_CURRENCY_LABEL to state these currencies and the differences will be computed.'
    );
  } else {
    warnings.push(
      'NO DIFFERENCES BETWEEN COMPANIES ARE COMPUTED, because they do not share a currency — ' +
        `these figures are in ${[...currencies].join(', ')}. Subtracting across them would ` +
        'produce a number that looks like a movement and means nothing, and nothing here ' +
        'converts between currencies. Compare them by reading the columns, not by taking ' +
        'differences, and never total the row.'
    );
  }

  return whole(
    {
      statement,
      period,
      companies: fetched.map((entry) => ({
        company: entry.company,
        currency: entry.currency,
        /** False when the label was inferred or absent rather than established. */
        currencyEstablished: entry.comparable,
      })),
      comparison: {
        rows: paired.rows,
        unpaired: paired.unpaired,
        differencesComputed: oneCurrency,
      },
      warnings,
    },
    paired.rows.length
  );
}
