import { z } from 'zod';
import { Decimal } from 'decimal.js';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  buildBalanceSheetRequest,
  buildCashFlowRequest,
  buildFundsFlowRequest,
  buildProfitLossRequest,
  buildTrialBalanceRequest,
  type TallyRequestOptions,
} from '../tally/requests.js';
import {
  normalizeBalanceSheet,
  normalizeMonthlyFlow,
  normalizeProfitLoss,
  normalizeTrialBalance,
  type Ledger,
  type Normalized,
} from '../tally/normalize.js';
import { fetchLedgers } from './ledgers.js';
import { fetchGroups } from './groups.js';
import {
  companySchema,
  dateRangeSchema,
  isoDateSchema,
  PERIOD_NOTE,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import {
  assertCompanyIsLoaded,
  resolveCompanyCurrency,
  companyNamed,
  resolvePeriodForCompany,
  runTool,
  whole,
  type ToolDeps,
} from './toolResult.js';
import {
  bookYearFor,
  endDateBinds as endDateIsHonoured,
  nearestBindingEndDate,
  todayIso,
  validateDateRange,
} from '../utils/dates.js';
import { CASH_FLOW_SUMMARY, FUND_FLOW_SUMMARY } from './flowReports.js';
import {
  compareStatements,
  type ComparisonAdapter,
  type RowFigures,
} from './statementComparison.js';
import { TallyError } from '../tally/TallyError.js';

/**
 * `tally_get_statement`: trial balance, balance sheet, profit and loss, cash
 * flow, fund flow.
 *
 * All five share a shape — a period, a company, and a flat list of rows — so
 * they share one tool behind a `statement` discriminator. What differs is
 * only the request builder, the normaliser and the descriptive text, because
 * Tally's reports use different tag vocabularies (and, for the two flow
 * reports, a genuinely different kind of content — see flowReports.ts) for
 * related ideas.
 *
 * These are report-class requests and use the longer timeout.
 */

const SIGN_NOTE =
  'SIGNS — read this before quoting a figure to the user. Values are reported exactly as ' +
  'TallyPrime encodes them and are never adjusted, which means DEBIT FIGURES ARRIVE NEGATIVE. ' +
  'TallyPrime own screen shows the same figure as a POSITIVE number in a "Debit" column: a ' +
  'debit of -1161289.87 here appears in Tally as 11,61,289.87 under Debit. Verified row by row ' +
  'against a live trial balance. So when reporting a debit, give the magnitude and say it is a ' +
  'debit — quoting the minus sign as though the balance were negative will contradict what the ' +
  'user sees on screen. Expense figures in the P&L arrive negative for the same reason. ' +
  'A null figure means Tally returned an empty column, which is NOT a zero — a genuine zero is ' +
  'reported as 0. This applies to the three classified statements (trial_balance, balance_sheet, ' +
  'profit_loss); the two flow variants keep their own sign convention, described below.';

const GROUP_NOTE =
  'GRANULARITY: top-level groups as TallyPrime presents them, not individual ledgers. ' +
  'For per-ledger balances use tally_get_masters type "ledger".';

/**
 * The rule, without the proof. The evidence behind it — a 19-point sweep of
 * `SVTODATE` against a live install — lives in docs/known-limitations.md, where
 * it is worth its length. Here it was spending tokens on every request to
 * justify a rule that must simply be followed.
 */
const END_DATE_NOTE = [
  'THE END DATE ONLY BINDS ON THE 31st. `fromDate` always binds. `toDate` is honoured only when ' +
    'it falls on the 31st of a month; on any other day TallyPrime ignores it and the figures ' +
    "accumulate from fromDate to the end of the company's own book year. This is verified " +
    'behaviour, not a guess, and it applies to a real month end like 30 November too.',
  '',
  'So 31 January, 31 March, 31 May, 31 July, 31 August, 31 October and 31 December work; ' +
    'every other end date silently gives you a longer period. Calendar quarter ends are the trap ' +
    '— 30 June and 30 September do NOT bind.',
  '',
  'Every response carries `coversPeriodRequested`. When FALSE, it also carries ' +
    '`figuresActuallyCover`, and the figures MUST be described as a cumulative position from ' +
    'fromDate — never as the period requested. For a date-bounded question use tally_get_vouchers ' +
    'or tally_summarise_movements, whose ranges are honoured to the day.',
].join('\n');

const COMPARISON_NOTE = [
  'COMPARING TWO PERIODS: pass compareFromDate and compareToDate to fetch the statement twice in ' +
    'one call. Never defaulted — supply both or neither.',
  '',
  'REFUSED unless BOTH periods end on a 31st, because of the end-date behaviour above: two ' +
    'periods that both got extended to the same year end would subtract to minus the whole ' +
    'earlier period rather than the movement between them, so the call fails with ' +
    'TALLY_UNSUPPORTED_OPERATION rather than return a wrong figure of plausible size. Shift each ' +
    'end date to a 31st and the comparison works.',
  '',
  'The response carries `rows` plus `comparison` holding its own `rows`, a `changes` array and ' +
    '`unpaired`. `change` = current − previous in TallyPrime signs on BOTH sides, so a growing ' +
    'DEBIT balance gives a MORE NEGATIVE change. Describe direction from the magnitudes and say ' +
    'which way you read it; never call a negative change a decrease without checking the side.',
  '',
  'Two limits on `changes`:',
  '- NULL in either period gives `change: null` and a `basis` naming the missing side. Null is ' +
    'Tally reporting nothing, not zero — never report such a row as having fallen to nil.',
  '- Rows pair by name, only where it occurs exactly once in BOTH periods. Repeats land in ' +
    '`unpaired.ambiguous`; names in one period only land in `unpaired.currentOnly` / ' +
    '`comparisonOnly` — an absent row, again not a zero.',
  '',
  'COST: two sequential report fetches, roughly double a single-period call.',
].join('\n');

const TRIAL_BALANCE_SUMMARY = [
  'trial_balance — closing debit and credit totals per account group. Use it to check the books ' +
    'balance, or as the starting point before drilling into groups or ledgers.',
].join('\n');

const BALANCE_SHEET_SUMMARY = [
  'balance_sheet — financial position at a date: one row per group with its main figure and, ' +
    'where Tally provides one, an indented sub-total.',
].join('\n');

const PROFIT_LOSS_SUMMARY = [
  'profit_loss — income and expenditure for the period, one row per group plus any sub-total. ' +
    'EXPENSES ARRIVE NEGATIVE. To compare two periods use compareFromDate/compareToDate rather ' +
    'than two calls, so the pairing and the null-is-not-zero rule below are applied for you.',
].join('\n');

const STATEMENT_DESCRIPTION = [
  'Fetch one of TallyPrime financial statements or flow reports for a period: trial balance, ' +
    'balance sheet, profit and loss, monthly cash movement, or monthly funds movement. Pick ' +
    'which with the `statement` parameter — one call, one statement. Optionally compare it ' +
    'against a second period in the same call.',
  '',
  TRIAL_BALANCE_SUMMARY,
  '',
  BALANCE_SHEET_SUMMARY,
  '',
  PROFIT_LOSS_SUMMARY,
  '',
  CASH_FLOW_SUMMARY,
  '',
  FUND_FLOW_SUMMARY,
  '',
  END_DATE_NOTE,
  '',
  GROUP_NOTE,
  '',
  COMPARISON_NOTE,
  '',
  SIGN_NOTE,
  '',
  PERIOD_NOTE,
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

export const statementSchema = z
  .enum(['trial_balance', 'balance_sheet', 'profit_loss', 'cash_flow', 'fund_flow'])
  .describe('Which statement or flow report to fetch. See the tool description for each.');

type StatementKey = z.infer<typeof statementSchema>;

interface StatementSpec<T> {
  build: (options: TallyRequestOptions) => string;
  /** `currency` is the loaded company's own, so figures are not mislabelled. */
  normalize: (xml: string, currency: string) => Normalized<T[]>;
  /**
   * How to pair this statement's rows across two periods. Supplied per
   * statement because the column names differ and the flow reports key on a
   * month rather than an account — see statementComparison.ts.
   */
  compare: ComparisonAdapter;
}

/** Read a named property off a row without asserting the row's own type. */
function field(row: unknown, name: string): unknown {
  return (row as Record<string, unknown> | null)?.[name];
}

function keyFrom(name: string): ComparisonAdapter['keyOf'] {
  return (row) => {
    const value = field(row, name);
    return typeof value === 'string' ? value : null;
  };
}

function figuresFrom(...columns: readonly string[]): ComparisonAdapter['figuresOf'] {
  return (row) => {
    const figures: RowFigures = {};
    for (const column of columns) {
      // Money or null as the normaliser produced it; nothing is coerced here.
      figures[column] = (field(row, column) ?? null) as RowFigures[string];
    }
    return figures;
  };
}

const BY_GROUP = (...columns: readonly string[]): ComparisonAdapter => ({
  keyOf: keyFrom('name'),
  figuresOf: figuresFrom(...columns),
  keyLabel: 'group',
});

const BY_MONTH: ComparisonAdapter = {
  keyOf: keyFrom('period'),
  figuresOf: figuresFrom('debit', 'credit', 'net'),
  keyLabel: 'month',
};

const STATEMENTS: { [K in StatementKey]: StatementSpec<unknown> } = {
  trial_balance: {
    build: buildTrialBalanceRequest,
    normalize: normalizeTrialBalance,
    compare: BY_GROUP('debit', 'credit'),
  },
  balance_sheet: {
    build: buildBalanceSheetRequest,
    normalize: normalizeBalanceSheet,
    compare: BY_GROUP('amount', 'subAmount'),
  },
  profit_loss: {
    build: buildProfitLossRequest,
    normalize: normalizeProfitLoss,
    compare: BY_GROUP('amount', 'subAmount'),
  },
  cash_flow: {
    build: buildCashFlowRequest,
    normalize: (xml, currency) => normalizeMonthlyFlow(xml, 'cash flow', currency),
    compare: BY_MONTH,
  },
  fund_flow: {
    build: buildFundsFlowRequest,
    normalize: (xml, currency) => normalizeMonthlyFlow(xml, 'funds flow', currency),
    compare: BY_MONTH,
  },
};

/**
 * When TallyPrime honours SVTODATE on these reports — the guard that exists
 * because it usually does not.
 *
 * **Corrected 2026-08-14.** This was previously recorded as "SVTODATE is always
 * ignored", verified live 2026-08-12: a `Cash Flow` for 1-Jul to 30-Sep returned
 * NINE monthly rows, and a `Trial Balance` for 1-Apr to 30-Jun matched the whole
 * year row for row. Both observations are real and still reproduce. The
 * generalisation drawn from them was wrong.
 *
 * A 19-point sweep with the cache off (`scripts/probe-todate-binding.ts`) found
 * the actual rule: **SVTODATE binds if and only if its day of the month is the
 * 31st.** 31 January, 31 March, 31 May, 31 July, 31 August and 31 December each
 * returned exactly the months requested; 29 February, 15 March, 30 March,
 * 30 April, 30 June, 30 September and 30 November each returned the whole book
 * year. 30 November is what rules out "the last day of the month" — it is a real
 * month end and it is still ignored.
 *
 * The earlier evidence fits this rule exactly. Both of those tests ended on a
 * calendar quarter end, and three of the four quarter ends fall on the 30th;
 * 1-Jul to the year end of an April company is nine months to the row. The
 * original conclusion was not a bad inference, it was an under-sampled one.
 *
 * Why it went unnoticed even earlier: the first trial balance reconciliation ran
 * 1-Apr-26 to 28-Jul-26 on a company holding nothing after 28 July, and
 * "accumulated to the year end" and "as at the end date" agree when there are no
 * transactions in between.
 *
 * The consequence for a comparison is worse than a wrong period. If both sides
 * get extended to the same year end, subtracting them collapses algebraically to
 * *minus the whole of the earlier period's activity* — on the company probed,
 * a Q2-vs-Q1 comparison reported sales down 211,852.50 when sales were flat,
 * because 211,852.50 was the entirety of Q1. A fabricated figure of plausible
 * size, in answer to the one question the feature exists to answer, with no
 * warning. Hence: still refuse, but now only when an end date genuinely does not
 * bind, rather than for every period that is not the year end.
 */
function statementEndDateIsIgnored(toDate: string): string {
  return (
    `TallyPrime did not honour the end date ${toDate} on this report. Verified against a live ` +
    'install by sweeping the end date across a range: it binds ONLY when it falls on the 31st of ' +
    'a month, and is ignored on every other day — including a real month end such as 30 November. ' +
    // Re-measured 2026-08-14 with four different date wire formats (YYYYMMDD,
    // d-MMM-yyyy, a TYPE="Date" attribute, and ISO). The first three behave
    // identically, so the rule is a property of the report and not an artefact
    // of how the date is written. ISO is silently mis-parsed and is never sent.
    'When ignored, figures accumulate from fromDate to the end of the LAST book year the company ' +
    'has, which is often far past both the date you asked for and the last date the company holds ' +
    'data for — so this is a much longer span than "the year you asked about". Measured on a ' +
    'company whose books run 2021-04-01 to 2026-07-28: every request, from any start date, ' +
    'accumulated to 2027-03-31, turning a request for one financial year into four years of ' +
    'cumulative figures. See figuresActuallyCover for the span these numbers really represent.'
  );
}

/**
 * Tally's top-level groups carry the parent name "Primary". It is a sentinel
 * for "no parent", not a real group, and walking through it files every ledger
 * under one key — which makes the comparison below compare nothing while
 * appearing to pass.
 */
const PRIMARY_GROUP = 'primary';

/** Rounding floor. Below this, two figures are the same figure. */
const TOLERANCE = '0.005';

/**
 * Where the trial balance and the ledger masters disagree — and why that has
 * to be said out loud rather than quietly picked between.
 *
 * Found live 2026-08-13 against real books: `trial_balance` reported Current
 * Assets as -385,764.46, while the closing balances `tally_get_masters type "ledger"` gives
 * for the same group summed to -482,384.46. The difference, 96,620.00, is
 * exactly the year's movement on `Stock In Hand` (opening -207,968, closing
 * -304,588). `balance_sheet` agreed with the masters to the cent on every
 * group, as did the trial balance on all seven other groups.
 *
 * So TallyPrime's Trial Balance carries stock at its OPENING value while its
 * Balance Sheet and the ledger masters carry the CLOSING value. Both are
 * Tally's own figures and both are passed through untouched — §6 rule 1
 * forbids adjusting either. What was missing was any statement that two tools
 * answer "what are current assets" on different bases. A 20% difference,
 * quoted from whichever tool happened to be called first, is a wrong answer of
 * entirely plausible size, which is the failure mode this codebase treats as
 * the serious one.
 *
 * The check OBSERVES rather than assumes: it compares every group row against
 * the masters and reports whatever differs, then names the account whose
 * movement accounts for the gap when one does. A company that integrates
 * accounts with inventory shows no difference and gets no warning — the right
 * outcome, and not one this code has to know about in advance. It also catches
 * any future divergence of this kind, not only the stock one.
 *
 * Never throws. A diagnostic that turns a correct answer into an error is
 * worse than the inconsistency it reports — the same rule as companyPeriodEnd.
 */
async function noteMastersDivergence(
  deps: ToolDeps,
  company: string | undefined,
  rows: readonly unknown[]
): Promise<string[]> {
  try {
    const [{ ledgers }, { groups }] = await Promise.all([
      fetchLedgers(deps, company),
      fetchGroups(deps, company),
    ]);

    // Trimmed throughout: TallyPrime pads its primary-group name with a leading
    // space, the same trap derivedBalanceReason() in tieOut.ts documents. An
    // untrimmed key misses in the map, the walk stops one level too early, and
    // the comparison below quietly compares nothing instead of failing.
    const key = (value: string | null): string => (value ?? '').trim().toLowerCase();
    const parentOf = new Map(groups.map((group) => [key(group.name), key(group.parent)]));
    const rootOf = (name: string | null): string => {
      let current = key(name);
      for (let hops = 0; hops < 20; hops++) {
        const parent = parentOf.get(current);
        if (parent === undefined || parent === '' || parent === PRIMARY_GROUP) break;
        current = parent;
      }
      return current;
    };

    const mastersByRoot = new Map<string, Decimal>();
    const ledgersByRoot = new Map<string, Ledger[]>();
    for (const ledger of ledgers) {
      const root = rootOf(ledger.parent);
      ledgersByRoot.set(root, [...(ledgersByRoot.get(root) ?? []), ledger]);
      // A null closing balance is Tally reporting nothing, not a zero, so it
      // contributes nothing rather than being added as 0.
      if (ledger.closingBalance === null) continue;
      mastersByRoot.set(
        root,
        (mastersByRoot.get(root) ?? new Decimal(0)).plus(ledger.closingBalance.amount)
      );
    }

    const notes: string[] = [];
    for (const row of rows) {
      const name = field(row, 'name');
      if (typeof name !== 'string') continue;
      const masters = mastersByRoot.get(key(name));
      // Rows Tally derives rather than posts — "Profit & Loss A/c" — have no
      // ledgers filed under them. Nothing to compare, so nothing to say.
      if (masters === undefined) continue;

      const money = (column: string): string => {
        const value = field(row, column);
        const amount = (value as { amount?: unknown } | null)?.amount;
        return typeof amount === 'string' ? amount : '0';
      };
      const stated = new Decimal(money('debit')).plus(money('credit'));
      const difference = stated.minus(masters);
      if (difference.abs().lessThan(TOLERANCE)) continue;

      // A row carried at its OPENING value differs from the masters by exactly
      // opening minus closing, which identifies the account responsible
      // without this code having to know which account it should be.
      const carriedAtOpening = (ledgersByRoot.get(key(name)) ?? []).filter(
        (ledger) =>
          ledger.openingBalance !== null &&
          ledger.closingBalance !== null &&
          new Decimal(ledger.openingBalance.amount)
            .minus(ledger.closingBalance.amount)
            .minus(difference)
            .abs()
            .lessThan(TOLERANCE)
      );
      const culprit = carriedAtOpening.length === 1 ? carriedAtOpening[0] : undefined;

      notes.push(
        `"${name}" is ${stated.toString()} on this trial balance, but the closing balances ` +
          `tally_get_masters type "ledger" reports for the same group add up to ${masters.toString()} — a ` +
          `difference of ${difference.toString()}. ` +
          (culprit === undefined
            ? ''
            : `That is exactly the period movement on "${culprit.name}" (opening ` +
              `${culprit.openingBalance?.amount ?? 'unreported'}, closing ` +
              `${culprit.closingBalance?.amount ?? 'unreported'}), so TallyPrime's trial balance ` +
              `carries that account at its OPENING value while tally_get_masters type "ledger" and ` +
              `tally_get_statement (balance_sheet) carry its CLOSING value. `) +
          `Both figures are TallyPrime's own and neither has been adjusted here. State which ` +
          `basis you are quoting, and do not present the two as agreeing.`
      );
    }

    return notes;
  } catch {
    return [];
  }
}

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

export function registerReportTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_get_statement',
    {
      description: STATEMENT_DESCRIPTION,
      inputSchema: z.object({
        statement: statementSchema,
        company: companySchema,
        ...dateRangeSchema,
        compareFromDate: isoDateSchema
          .optional()
          .describe(
            'Start of a second period to compare against, ISO YYYY-MM-DD. Supply with ' +
              'compareToDate to get the same statement for both periods plus the movement per ' +
              'row. Omit both for a single period.'
          ),
        compareToDate: isoDateSchema
          .optional()
          .describe(
            'End of the comparison period, ISO YYYY-MM-DD. Must be on or after compareFromDate.'
          ),
      }),
    },
    async (args) =>
      runTool('tally_get_statement', deps, async () => {
        const spec = STATEMENTS[args.statement];
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
            ...(company === undefined ? {} : { company }),
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
        const divergenceWarnings =
          args.statement === 'trial_balance'
            ? await noteMastersDivergence(deps, args.company, current.rows)
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

        if (comparisonPeriod === undefined) {
          const allWarnings = [...periodWarnings, ...divergenceWarnings, ...current.warnings];
          // A statement is returned whole — it is not paginated and this server
          // applies no cap of its own, so every row Tally rendered is here.
          return whole(
            {
              statement: args.statement,
              period,
              coversPeriodRequested: endDateBinds,
              ...(endDateBinds
                ? {}
                : { figuresActuallyCover: { fromDate: period.fromDate, toDate: periodEnd } }),
              ...(args.company === undefined ? {} : { company: args.company }),
              rows: current.rows,
              ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
            },
            current.rows.length
          );
        }

        // Sequential, not parallel: Tally's listener serves one request at a
        // time and the client queue would serialise these anyway. Awaiting in
        // order keeps the failure attributable to a period.
        const comparison = await fetchFor(comparisonPeriod);
        const compared = compareStatements(current.rows, comparison.rows, spec.compare);

        const allWarnings = [
          ...divergenceWarnings,
          ...current.warnings,
          ...comparison.warnings,
          ...compared.warnings,
        ];

        return whole(
          {
            statement: args.statement,
            period,
            coversPeriodRequested: endDateBinds,
            ...(args.company === undefined ? {} : { company: args.company }),
            rows: current.rows,
            comparison: {
              period: comparisonPeriod,
              rows: comparison.rows,
              changes: compared.changes,
              unpaired: compared.unpaired,
            },
            ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
          },
          // Both periods' rows are accounting data the caller received.
          current.rows.length + comparison.rows.length
        );
      })
  );
}
