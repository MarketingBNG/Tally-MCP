import { z } from 'zod';
import { Decimal } from 'decimal.js';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  buildBalanceSheetRequest,
  buildCashFlowRequest,
  buildFundsFlowRequest,
  buildProfitLossRequest,
  buildTrialBalanceRequest,
  UNSCOPED,
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
import { fetchClosingStockTotal } from './closingStock.js';
import {
  companySchema,
  dateRangeSchema,
  isoDateSchema,
  PERIOD_NOTE,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
  verbositySchema,
} from '../schemas/common.js';
import { trimWarnings } from './verbosity.js';
import {
  assertCompanyIsLoaded,
  resolveCompanyCurrency,
  resolveCompanyCurrencyDetailed,
  companyNamed,
  notePeriodBeyondBooks,
  resolvePeriodForCompany,
  runTool,
  whole,
  type ToolDeps,
  type ToolBodyResult,
} from './toolResult.js';
import {
  bookYearFor,
  endDateBinds as endDateIsHonoured,
  nearestBindingEndDate,
  todayIso,
  validateDateRange,
  type DateRange,
} from '../utils/dates.js';
import { CASH_FLOW_SUMMARY, FUND_FLOW_SUMMARY } from './flowReports.js';
import {
  buildTrend,
  compareStatements,
  rowIsNil,
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
/**
 * The stock line on a `profit_loss`, when it carries one.
 *
 * Rows arrive as `{ name, amount, subAmount }` and Tally puts the stock figures
 * on `subAmount` under the Cost of Sales block, so both are read and the first
 * present one wins. Matched on the row name because that is all the report
 * gives — there is no group code on a P&L row.
 */
function stockFigure(rows: readonly unknown[], label: string): Decimal | null {
  for (const row of rows) {
    const record = row as {
      name?: unknown;
      amount?: { amount?: unknown } | null;
      subAmount?: { amount?: unknown } | null;
    };
    if (typeof record.name !== 'string') continue;
    if (record.name.trim().toLowerCase() !== label) continue;
    const raw = record.subAmount?.amount ?? record.amount?.amount;
    if (typeof raw !== 'string' || raw === '') return null;
    try {
      return new Decimal(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/** Rounding floor for the stock comparison, in currency units. */
const STOCK_TOLERANCE = new Decimal('0.01');

/**
 * Where the profit and loss carries stock at a value the Stock Summary does
 * not agree with — and why that has to be said on THIS statement.
 *
 * The trial balance already discloses a version of this through
 * noteMastersDivergence: TallyPrime's TB carries stock at its OPENING value
 * while the balance sheet and masters carry the closing one. The profit and
 * loss had no equivalent, and it is the statement where the consequence is
 * largest, because stock sits inside the Cost of Sales block and a stale
 * closing figure does not merely misstate the balance sheet — it misstates
 * GROSS PROFIT, one for one.
 *
 * Found live 2026-08-18 on AgEx Pharma LLC: the P&L reported Opening Stock and
 * Less: Closing Stock as the SAME figure, -304,588, over a period in which five
 * sales invoices relieved 1,900 Kg of stock across three items with full batch
 * and godown allocations. Cost of sales came out nil and `ratio_analysis`
 * reported Gross Profit % and Nett Profit % at 100.00%. The Stock Summary for
 * the same company totalled -239,687.94 — a gap of 64,900.06 that no tool
 * mentioned. An accountant reading the P&L alone would have concluded the
 * inventory was never posted; it was posted, and the closing VALUATION was
 * stale.
 *
 * Two independent triggers, because they catch different failures:
 *
 * 1. Opening equals closing exactly. Free — read off rows already fetched. On
 *    a period with any trading at all this is near-impossible as a genuine
 *    outcome, and it is the signature of a period whose stock was never
 *    revalued.
 * 2. The P&L closing figure disagrees with the Stock Summary. Costs one
 *    request, and is the check that produces the actual number.
 *
 * NOTHING IS ADJUSTED. Both figures are TallyPrime's own and both are passed
 * through untouched — §6 rule 1. What is added is the statement that they
 * disagree, and by how much, so the figure is not quoted as a fact about the
 * period when it is a fact about the opening position.
 *
 * Never throws, for the same reason as noteMastersDivergence.
 */
async function noteStaleClosingStock(
  deps: ToolDeps,
  company: string | undefined,
  rows: readonly unknown[]
): Promise<string[]> {
  try {
    const opening = stockFigure(rows, 'opening stock');
    const closing = stockFigure(rows, 'less: closing stock') ?? stockFigure(rows, 'closing stock');

    // No stock line at all: a company that does not maintain inventory, which
    // is a correct outcome and not something to warn about.
    if (closing === null && opening === null) return [];

    const warnings: string[] = [];

    if (
      opening !== null &&
      closing !== null &&
      opening.equals(closing) &&
      !opening.isZero()
    ) {
      warnings.push(
        `This profit and loss reports Opening Stock and Closing Stock as the SAME figure ` +
          `(${opening.abs().toFixed(2)}). Cost of sales is therefore struck with NO stock ` +
          'movement in it, and gross profit is overstated by whatever the movement was. ' +
          'Verified live: this occurs on a period whose closing stock was never revalued, ' +
          'including periods in which invoices did relieve stock with full batch and godown ' +
          'allocations. Check tally_get_inventory_movements for the period before concluding ' +
          'that no inventory was posted — the entries and the valuation fail separately.'
      );
    }

    // Only paid for when there is a stock line to check it against.
    if (closing !== null) {
      const summary = await fetchClosingStockTotal(deps, company);
      if (summary !== null) {
        const gap = closing.abs().minus(summary.abs());
        if (gap.abs().greaterThan(STOCK_TOLERANCE)) {
          warnings.push(
            `The closing stock on this profit and loss (${closing.abs().toFixed(2)}) does NOT ` +
              `agree with TallyPrime's own Stock Summary (${summary.abs().toFixed(2)}) — a ` +
              `difference of ${gap.abs().toFixed(2)}. Both are TallyPrime's own figures and ` +
              'neither has been adjusted here. TallyPrime is known to carry stock on different ' +
              'bases in different reports, so this is not a reading error. Because closing ' +
              'stock sits inside Cost of Sales, the difference passes straight through to ' +
              `gross profit: it is ${gap.greaterThan(0) ? 'OVERSTATED' : 'UNDERSTATED'} by ` +
              `${gap.abs().toFixed(2)} on this statement if the Stock Summary is the right ` +
              'basis. Establish which basis the accounts are drawn on before quoting either.'
          );
        }
      }
    }

    return warnings;
  } catch {
    return [];
  }
}

/**
 * Ledger-name fragments that mark a COST RECOVERY rather than a sale.
 *
 * Freight, packing and insurance recharged to a customer are recoveries of a
 * cost, not revenue from the entity's ordinary activities. Presented gross
 * inside sales they overstate both revenue and margin.
 *
 * Deliberately conservative. Only terms whose ordinary accounting meaning is a
 * delivery or handling cost, so a genuine revenue stream — "Freight Income" at
 * a haulier, say — is a false positive this ACCEPTS rather than one it hides.
 * The note says the classification is a judgement and never adjusts a figure.
 */
const COST_RECOVERY_HINTS = [
  'freight',
  'transport',
  'carriage',
  'packing',
  'courier',
  'delivery',
  'shipping',
  'insurance',
];

/** Group names whose contents are revenue for this purpose. */
const REVENUE_GROUP_HINTS = ['sales account', 'direct income', 'indirect income', 'revenue'];

/**
 * Cost recoveries sitting inside revenue — found on the masters, not the rows.
 *
 * WHY THE MASTERS. A profit and loss reports GROUPS: "Sales Accounts" is one
 * row and the ledgers inside it are invisible, so nothing on the statement
 * itself can show that part of the figure is recovered freight. The ledger
 * masters carry the parent group, which is where it is visible.
 *
 * Found live 2026-08-18 on AgEx Pharma LLC: `Transport Cost`, parent
 * `Sales Accounts`, closing 805.00, credited into the revenue side of
 * invoice AgEx/INV/02 alongside the goods.
 *
 * NOTHING IS RECLASSIFIED and no figure moves. Whether a recovery is revenue
 * (ASC 606-10-32 / Ind AS 115) depends on whether the entity controls the
 * shipping service before transfer, which no ledger name settles. This names
 * the ledgers and their size so the judgement can be made, and says plainly
 * that it is a judgement.
 *
 * Never throws.
 */
async function noteCostRecoveriesInRevenue(
  deps: ToolDeps,
  company: string | undefined
): Promise<string[]> {
  try {
    const { ledgers } = await fetchLedgers(deps, company);

    const suspects = ledgers.filter((ledger) => {
      const parent = (ledger.parent ?? '').trim().toLowerCase();
      if (!REVENUE_GROUP_HINTS.some((hint) => parent.includes(hint))) return false;
      const name = ledger.name.toLowerCase();
      return COST_RECOVERY_HINTS.some((hint) => name.includes(hint));
    });

    if (suspects.length === 0) return [];

    const listed = suspects
      .map((ledger) => {
        const amount = ledger.closingBalance?.amount;
        return `"${ledger.name}" (under "${ledger.parent ?? 'unknown'}"${
          amount === undefined || amount === null ? '' : `, ${new Decimal(amount).abs().toFixed(2)}`
        })`;
      })
      .join(', ');

    return [
      `${String(suspects.length)} ledger(s) grouped under revenue are named as COST RECOVERIES ` +
        `rather than sales: ${listed}. Freight, packing and insurance recharged to a customer ` +
        'are recoveries of a cost; presented gross inside sales they overstate both revenue and ' +
        'gross margin by their amount. Nothing here has been reclassified and no figure has ' +
        'moved — whether a recovery is revenue depends on whether the entity controls the ' +
        'service before it transfers to the customer, which a ledger name cannot settle. Verified ' +
        'live: one such ledger was credited into the revenue side of a sales invoice alongside ' +
        'the goods. Check the grouping before quoting revenue or margin from this statement.',
    ];
  } catch {
    return [];
  }
}

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
    /**
     * How many ledgers under each root reported NO closing balance, and were
     * therefore not in the sum below.
     *
     * WHY THIS IS COUNTED. Skipping a null is right — rule 1, a null is Tally
     * reporting nothing and adding it as zero would invent a figure. But the
     * note this function emits then says the masters "add up to" a number,
     * and presents it as the counterpart of the trial balance total. When some
     * of the group was unreadable that number is a sum over a SUBSET, and the
     * difference it reports is part real basis difference and part simply
     * data that was never read. The reader cannot tell which, and the honest
     * reading of a large difference — "these two disagree, reconcile before
     * quoting" — is then partly wrong.
     *
     * Verified live 2026-08-17 on AGBV Nutrition GmbH: 5 of the 10 ledgers
     * under Sales Accounts and 68 of the 87 under Indirect Expenses report no
     * closing balance at all. On that company they turned out to be genuinely
     * unused ledgers — `Sales Income` has zero vouchers in the period, so the
     * sum was complete after all — but nothing in the output said so, and on a
     * company where they are NOT empty the same note would read identically.
     * So the count is disclosed rather than the sum being silently partial.
     */
    const unreadableByRoot = new Map<string, number>();
    for (const ledger of ledgers) {
      const root = rootOf(ledger.parent);
      ledgersByRoot.set(root, [...(ledgersByRoot.get(root) ?? []), ledger]);
      // A null closing balance is Tally reporting nothing, not a zero, so it
      // contributes nothing rather than being added as 0.
      if (ledger.closingBalance === null) {
        unreadableByRoot.set(root, (unreadableByRoot.get(root) ?? 0) + 1);
        continue;
      }
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

      // How much of this group the masters figure actually covers. Stated
      // whenever anything was unreadable, so a partial sum is never presented
      // as a whole one — see `unreadableByRoot`.
      const unreadable = unreadableByRoot.get(key(name)) ?? 0;
      const total = (ledgersByRoot.get(key(name)) ?? []).length;
      const coverage =
        unreadable === 0
          ? ''
          : `That masters figure is the sum of ${String(total - unreadable)} of the ` +
            `${String(total)} ledger(s) in this group: the other ${String(unreadable)} report no ` +
            `closing balance at all, and a missing balance is not a zero, so they were left out ` +
            `rather than added as nought. Part of the difference above may therefore be ledgers ` +
            `that were never read rather than a real disagreement. Check them with ` +
            `tally_get_ledger_transactions before treating the gap as a reconciling item — an ` +
            `unused ledger genuinely holds nothing, and TallyPrime reports those the same way. `;

      notes.push(
        `"${name}" is ${stated.toString()} on this trial balance, but the closing balances ` +
          `tally_get_masters type "ledger" reports for the same group add up to ${masters.toString()} — a ` +
          `difference of ${difference.toString()}. ` +
          coverage +
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
async function runTrend(
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
async function runMultiCompany(
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
            'End of the comparison period, ISO YYYY-MM-DD. Must be on or after compareFromDate. ' +
              'This AND toDate must both fall on the 31st of a month — see the end-date rule in ' +
              'the description. Otherwise the call is refused with TALLY_UNSUPPORTED_OPERATION: ' +
              'two periods both silently extended to the same year end would subtract to minus ' +
              'the whole earlier period rather than the movement between them, which is a wrong ' +
              'figure of entirely plausible size. Shift each end date to a 31st and it works.'
          ),
        companies: z
          .array(z.string().min(1))
          .min(2)
          .max(10)
          .optional()
          .describe(
            'Two to ten companies to run this statement across, side by side. Every one must ' +
              'already be OPEN in TallyPrime — Tally holds several at once and this reads each in ' +
              'turn. Requires explicit fromDate and toDate: the companies keep different book ' +
              'years, so a defaulted period would silently compare different months. NO ' +
              'DIFFERENCES ARE COMPUTED between companies whose currencies differ, because ' +
              'subtracting a dollar figure from a rupee one produces a number that looks like a ' +
              'movement and means nothing.'
          ),
        periods: z
          .array(z.object({ fromDate: isoDateSchema, toDate: isoDateSchema }))
          .min(2)
          .max(12)
          .optional()
          .describe(
            'Two to twelve periods to run this statement across, giving a TREND: each row tracked ' +
              'through the series with the movement between consecutive periods. Use instead of ' +
              'fromDate/toDate/compareFromDate/compareToDate, not alongside them. Periods are kept ' +
              'in the order you give them and are NOT sorted, because "Q4 against Q1" is a real ' +
              'question and reordering would relabel every movement. EVERY period end date must ' +
              'fall on the 31st of a month — see the end-date rule in this description; a period ' +
              'ending otherwise is refused rather than answered with figures that run past it.'
          ),
        verbosity: verbositySchema,
      }),
    },
    async (args) =>
      runTool('tally_get_statement', deps, async () => {
        const spec = STATEMENTS[args.statement];
        const verbosity = args.verbosity ?? 'full';

        if (args.companies !== undefined) {
          if (args.periods !== undefined || args.company !== undefined) {
            throw new TallyError(
              'INVALID_PARAMETERS',
              'Give `companies` on its own, not with `company` or `periods`.',
              {
                suggestion:
                  'One statement, one period, several companies. A trend across several periods ' +
                  'AND several companies is a grid rather than a statement — run one call per ' +
                  'company if that is what you need, so each result says plainly what it covers.',
              }
            );
          }
          return runMultiCompany(deps, args.statement, args.companies, args.fromDate, args.toDate);
        }

        if (args.periods !== undefined) {
          if (
            args.fromDate !== undefined ||
            args.toDate !== undefined ||
            args.compareFromDate !== undefined ||
            args.compareToDate !== undefined
          ) {
            throw new TallyError(
              'INVALID_PARAMETERS',
              'Give either `periods` or the fromDate/toDate/compare* parameters, not both.',
              {
                suggestion:
                  'A trend already carries every period it covers, so a separate period would ' +
                  'either duplicate one of them or add a period the trend does not describe. ' +
                  'Drop whichever you did not mean.',
              }
            );
          }
          return runTrend(deps, args.statement, args.periods, args.company);
        }

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
        const divergenceWarnings =
          args.statement === 'trial_balance'
            ? await noteMastersDivergence(deps, args.company, current.rows)
            : args.statement === 'profit_loss'
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

        if (comparisonPeriod === undefined) {
          const allWarnings = [...periodWarnings, ...partialPeriodWarnings, ...divergenceWarnings, ...current.warnings];

          // At "summary", rows where every figure is nil are left out. They are
          // the chart of accounts showing through rather than facts about the
          // period, and on a full chart they are usually most of the rows. The
          // count is reported so the omission is visible, and the totals above
          // were computed over the WHOLE set before anything was dropped.
          const summarising = verbosity === 'summary';
          const visibleRows = summarising
            ? current.rows.filter((row) => !rowIsNil(spec.compare.figuresOf(row)))
            : current.rows;
          const nilRowsOmitted = current.rows.length - visibleRows.length;
          const trimmed = trimWarnings(verbosity, allWarnings);

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
              rows: visibleRows,
              ...(summarising
                ? {
                    verbosity,
                    rowsReturned: visibleRows.length,
                    rowsInStatement: current.rows.length,
                    nilRowsOmitted,
                    ...(nilRowsOmitted === 0
                      ? {}
                      : {
                          nilRowsNote:
                            `${String(nilRowsOmitted)} row(s) whose every figure was nil or zero ` +
                            'were omitted. No row carrying a figure was omitted, and no row with ' +
                            'an unreadable amount was treated as zero. Call again with verbosity ' +
                            '"full" for the complete statement.',
                        }),
                    ...(trimmed.note === undefined ? {} : { verbosityNote: trimmed.note }),
                  }
                : {}),
              ...(trimmed.warnings.length > 0 ? { warnings: trimmed.warnings } : {}),
            },
            visibleRows.length
          );
        }

        // Sequential, not parallel: Tally's listener serves one request at a
        // time and the client queue would serialise these anyway. Awaiting in
        // order keeps the failure attributable to a period.
        const comparison = await fetchFor(comparisonPeriod);
        const compared = compareStatements(current.rows, comparison.rows, spec.compare);

        const allWarnings = [
          ...partialPeriodWarnings,
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
