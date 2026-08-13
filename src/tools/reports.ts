import { z } from 'zod';
import { Decimal } from 'decimal.js';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  buildBalanceSheetRequest,
  buildCashFlowRequest,
  buildCompanyListRequest,
  buildFundsFlowRequest,
  buildProfitLossRequest,
  buildTrialBalanceRequest,
  type TallyRequestOptions,
} from '../tally/requests.js';
import {
  normalizeBalanceSheet,
  normalizeCompanies,
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
  resolvePeriod,
  runTool,
  whole,
  type ToolDeps,
} from './toolResult.js';
import { financialYearFor, validateDateRange } from '../utils/dates.js';
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
  'For per-ledger balances use tally_get_ledgers.';

/**
 * The rule, without the proof. The evidence behind it — a three-month Cash Flow
 * request returning nine months, a first-quarter Trial Balance identical to the
 * whole year — lives in docs/known-limitations.md, where it is worth its length.
 * Here it was spending tokens on every request to justify a rule that must simply
 * be followed.
 */
const END_DATE_NOTE = [
  'THE END DATE IS NOT HONOURED. `fromDate` binds, `toDate` does NOT: figures accumulate from ' +
    "fromDate to the end of the company's financial year whatever end date is asked for.",
  '',
  'Every response carries `coversPeriodRequested`. When FALSE, it also carries ' +
    '`figuresActuallyCover`, and the figures MUST be described as a cumulative position from ' +
    'fromDate — never as the period requested. For a date-bounded question use tally_get_vouchers ' +
    'or tally_summarise_movements, whose ranges are honoured.',
].join('\n');

const COMPARISON_NOTE = [
  'COMPARING TWO PERIODS: pass compareFromDate and compareToDate to fetch the statement twice in ' +
    'one call. Never defaulted — supply both or neither.',
  '',
  'REFUSED unless the main period ends on the financial year end, because of the end-date ' +
    'behaviour above: two periods accumulating to the same year end would subtract to minus the ' +
    'whole earlier period rather than the movement between them, so the call fails with ' +
    'TALLY_UNSUPPORTED_OPERATION rather than return a wrong figure of plausible size. Two ' +
    'cumulative positions from different start dates, both run to the year end, is the shape that ' +
    'works.',
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
 * TallyPrime ignores SVTODATE on these reports — the guard that exists because
 * of it.
 *
 * Verified live 2026-08-12, and it is the most consequential thing found so far
 * about these five reports. A `Cash Flow` request carrying
 * `<SVFROMDATE>20250701</SVFROMDATE><SVTODATE>20250930</SVTODATE>` returned NINE
 * monthly rows, July through March. A `Trial Balance` for 1-Apr to 30-Jun
 * returned figures identical, row for row, to the same report for the whole
 * financial year. So `SVFROMDATE` binds and **`SVTODATE` does not**: the figures
 * accumulate from the start date to the end of the company's financial year,
 * whatever end date was asked for.
 *
 * Why this went unnoticed until a second company was probed: the original trial
 * balance reconciliation covered 1-Apr-26 to 28-Jul-26 on a company whose books
 * held nothing after 28 July. "Accumulated to the year end" and "as at the end
 * date" produce the same figures when there are no transactions in between, so
 * the check that was meant to catch exactly this class of error could not.
 *
 * The consequence for a comparison is worse than a wrong period. If both sides
 * accumulate to the same year end, subtracting them collapses algebraically to
 * *minus the whole of the earlier period's activity* — on the company probed,
 * a Q2-vs-Q1 comparison reported sales down 211,852.50 when sales were flat,
 * because 211,852.50 was the entirety of Q1. A fabricated figure of plausible
 * size, in answer to the one question the feature exists to answer, with no
 * warning. Hence: refuse.
 */
const STATEMENT_TO_DATE_IS_IGNORED = [
  'TallyPrime ignores the end date on this report. Verified against a live install: figures ' +
    "accumulate from fromDate to the end of the company's financial year, whatever toDate is " +
    'given. A three-month Cash Flow request returned nine months, and a first-quarter Trial ' +
    'Balance returned the whole year.',
].join('');

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
 * Assets as -385,764.46, while the closing balances `tally_get_ledgers` gives
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
          `tally_get_ledgers reports for the same group add up to ${masters.toString()} — a ` +
          `difference of ${difference.toString()}. ` +
          (culprit === undefined
            ? ''
            : `That is exactly the period movement on "${culprit.name}" (opening ` +
              `${culprit.openingBalance?.amount ?? 'unreported'}, closing ` +
              `${culprit.closingBalance?.amount ?? 'unreported'}), so TallyPrime's trial balance ` +
              `carries that account at its OPENING value while tally_get_ledgers and ` +
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
 * The end of the loaded company's financial year, or null when it cannot be read.
 *
 * Never throws: this is a guard, and a guard that turns a working call into an
 * error because a metadata lookup failed is worse than the thing it guards
 * against. A null means "could not check", which is reported as such.
 */
async function companyPeriodEnd(deps: ToolDeps): Promise<string | null> {
  try {
    const response = await deps.client.send(buildCompanyListRequest(), 'standard');
    const start = normalizeCompanies(response.body).data[0]?.startingFrom ?? null;
    return start === null ? null : financialYearFor(start).toDate;
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
        const period = resolvePeriod(args.fromDate, args.toDate);
        const comparisonPeriod = resolveComparisonPeriod(args.compareFromDate, args.compareToDate);
        await assertCompanyIsLoaded(deps, args.company);
        const currencyWarnings: string[] = [];
        const currency = await resolveCompanyCurrency(deps, args.company, currencyWarnings);

        const fetchFor = async (range: { fromDate: string; toDate: string }) => {
          const request = spec.build({
            ...(args.company === undefined ? {} : { company: args.company }),
            fromDate: range.fromDate,
            toDate: range.toDate,
            format: deps.config.tallyPreferredFormat,
          });

          // Statements are report-class: they get the longer timeout.
          const response = await deps.client.send(request, 'report');
          const { data, warnings } = spec.normalize(response.body, currency);
          return { rows: data, warnings: [...response.repairs, ...currencyWarnings, ...warnings] };
        };

        // Checked before any comparison is attempted, because the failure mode
        // is a fabricated movement rather than a visibly wrong figure.
        const periodEnd = await companyPeriodEnd(deps);
        const endDateBinds = periodEnd !== null && period.toDate === periodEnd;

        if (comparisonPeriod !== undefined && !endDateBinds) {
          throw new TallyError(
            'TALLY_UNSUPPORTED_OPERATION',
            `Period comparison cannot be answered for ${period.fromDate} to ${period.toDate}. ${STATEMENT_TO_DATE_IS_IGNORED} Both periods would therefore accumulate to the same year end, and subtracting them yields minus the whole of the earlier period rather than the movement between them — a wrong figure of plausible size.`,
            {
              suggestion:
                periodEnd === null
                  ? "The loaded company's financial year end could not be read, so this cannot be checked. Fetch each period separately with tally_get_statement and compare only if you can establish what period Tally actually covered."
                  : `Fetch each period separately and read the figures as accumulating to ${periodEnd}, or compare cumulative positions by calling this tool once per fromDate with toDate ${periodEnd}. Do not subtract two mid-year statements.`,
              context: { requested: period, companyPeriodEnd: periodEnd },
            }
          );
        }

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
              `${STATEMENT_TO_DATE_IS_IGNORED} These figures therefore cover ${period.fromDate} to ` +
                `${periodEnd === null ? "the end of the company's financial year" : periodEnd}, NOT ` +
                `${period.toDate} as requested. Quote them as a cumulative position from ` +
                `${period.fromDate}, and do NOT describe them as the figures for the requested ` +
                'period. To ask about a shorter span, use tally_get_vouchers, whose date range ' +
                'TallyPrime does honour.',
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
