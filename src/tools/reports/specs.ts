import {
  z,
} from 'zod';

import {
  buildBalanceSheetRequest,
  buildCashFlowRequest,
  buildFundsFlowRequest,
  buildProfitLossRequest,
  buildTrialBalanceRequest,
  type TallyRequestOptions,
} from '../../tally/requests.js';
import {
  normalizeBalanceSheet,
  normalizeMonthlyFlow,
  normalizeProfitLoss,
  normalizeTrialBalance,
  type Normalized,
} from '../../tally/normalize.js';

import {
  PERIOD_NOTE,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../../schemas/common.js';

import {
} from '../toolResult.js';

import {
  CASH_FLOW_SUMMARY,
  FUND_FLOW_SUMMARY,
} from '../flowReports.js';
import {
  type ComparisonAdapter,
  type RowFigures,
} from '../statementComparison.js';

/**
 * What each statement IS: its request builder, normaliser, descriptive text and
 * comparison adapter.
 *
 * Split out of reports.ts at 1,498 lines. This module is declarative — the five
 * statements and the notes that describe them — and knows nothing about running
 * one. `STATEMENTS` is the table the runners read.
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

/**
 * What comes BACK from a multi-period or multi-company call.
 *
 * Deliberately says nothing about how to ASK for one. Each of `companies`,
 * `periods` and `compareFromDate`/`compareToDate` documents its own limits on
 * its own parameter, which is where Claude reads them when filling the call in;
 * this note used to restate all of it a second time, and at roughly three
 * thousand characters repeated on every request that was the single most
 * expensive paragraph in the tool list. What survives is the part with no
 * parameter to live on — the shape of the answer, and the two ways of
 * misreading it that produce a confidently wrong figure.
 */
const COMPARISON_NOTE = [
  'MORE THAN ONE COLUMN: compareFromDate/compareToDate for a second period, `periods` for a ' +
    'trend of two to twelve, `companies` for two to ten companies side by side. Mutually ' +
    'exclusive; each parameter carries its own rules. What follows is how to READ the result.',
  '',
  'The response carries `rows`, plus `comparison` holding its own `rows`, a `changes` array and ' +
    '`unpaired`.',
  '',
  'PAIRING is by NAME, and only where the name occurs exactly once on BOTH sides. A name ' +
    'appearing twice in any one period is excluded from the whole series rather than tracked in ' +
    'some periods and not others. Repeats land in `unpaired.ambiguous`; names present on one side ' +
    'only land in `unpaired.currentOnly` / `comparisonOnly`.',
  '',
  'NULL IS NOT ZERO. A row missing from a period is null — TallyPrime reported nothing, which is ' +
    'not the same as it reporting nil. Read `presentIn` before treating a series as a shape: a ' +
    'null read as zero looks like a fall to nothing. A null on either side gives `change: null` ' +
    'and a `basis` naming the missing side.',
  '',
  'DIRECTION: `change` = current − previous in TallyPrime signs on BOTH sides, so a growing ' +
    'DEBIT balance gives a MORE NEGATIVE change. Describe direction from the magnitudes and say ' +
    'which way you read it; never call a negative change a decrease without checking the side.',
  '',
  'CURRENCY: nothing here converts between currencies, ever. Where the companies compared do not ' +
    'all report the same one, the columns are shown but nothing is subtracted — a dollar figure ' +
    'minus a rupee one looks like a movement and means nothing. Read the columns; do not total ' +
    'the row.',
  '',
  'COST: one report fetch per period per company, run in turn.',
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

export const STATEMENT_DESCRIPTION = [
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
  'VERBOSITY: on a single-period statement, verbosity "summary" omits rows whose every figure ' +
    'is nil or zero — usually most of a full chart of accounts — and reports how many were left ' +
    'out. No row carrying a figure is ever omitted, and a row whose amount could not be read is ' +
    'kept rather than treated as zero.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

export const statementSchema = z
  .enum(['trial_balance', 'balance_sheet', 'profit_loss', 'cash_flow', 'fund_flow'])
  .describe('Which statement or flow report to fetch. See the tool description for each.');

export type StatementKey = z.infer<typeof statementSchema>;

export interface StatementSpec<T> {
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
export function field(row: unknown, name: string): unknown {
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

export const STATEMENTS: { [K in StatementKey]: StatementSpec<unknown> } = {
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
export function statementEndDateIsIgnored(toDate: string): string {
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
