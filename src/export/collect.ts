import {
  buildCurrencyListRequest,
  buildSimpleMasterRequest,
  SIMPLE_MASTER_TYPES,
  type SimpleMasterType,
} from '../tally/requests.js';
import {
  normalizeCurrencies,
  normalizeSimpleMasters,
  type SimpleMaster,
  type Company,
  type Currency,
  type Group,
  type Ledger,
  type StockItem,
  type Voucher,
  type VoucherType,
} from '../tally/normalize.js';
import {
  companyNamed,
  fetchCollection,
  resolveCompanyCurrencyDetailed,
  resolvePeriodForCompany,
  type ResolvedCurrency,
  type ToolDeps,
} from '../tools/toolResult.js';
import { fetchLedgers } from '../tools/ledgers.js';
import { fetchGroups } from '../tools/groups.js';
import { fetchVoucherTypes } from '../tools/voucherTypes.js';
import { fetchStockItems } from '../tools/inventory.js';
import { fetchVouchers } from '../tools/vouchers.js';
import { executeStatement, type ExecutedStatement } from '../tools/reports.js';
import { executeOutstanding, type ExecutedOutstanding } from '../tools/outstanding.js';
import { executeClosingStock, type ExecutedClosingStock } from '../tools/closingStock.js';
import {
  executeGenericReport,
  type ExecutedReport,
  type ReportKey,
} from '../tools/genericReport.js';
import { bookYearFor, type DateRange } from '../utils/dates.js';
import { bookYearsSpanning } from '../tools/vouchers.js';

/**
 * Everything the workbook needs, fetched once.
 *
 * ## The one rule this file follows
 *
 * **Never re-derive a figure.** Every fetch below calls an existing
 * `fetch*`/`execute*` function that a tool already uses, exactly as
 * `tally_make_workpaper` does. A second way to get the same data is a second
 * answer waiting to happen, and the failure would be a workbook disagreeing
 * with the connector on the same books.
 *
 * ## Warnings are collected, not discarded
 *
 * The workbook is the interface now — Claude answers from its rows rather than
 * from tools that attach their own caveats — so every warning the fetches
 * produced travels to the Manifest tab verbatim. Dropping one here is how a
 * trial balance carrying stock at OPENING gets read as the closing position.
 */

/** One company's books, as read in a single export run. */
export interface CompanyData {
  /** TallyPrime's own spelling. The authoritative name; the folder is a label. */
  company: Company;
  currency: ResolvedCurrency;
  /** The span the VOUCHER tabs cover — every book year the company holds. */
  period: DateRange;
  /** The period the STATEMENT tabs cover, which is the current book year. */
  statementPeriod: DateRange;
  /** When this read finished, ISO 8601. The Manifest's as-of stamp. */
  asOf: string;

  vouchers: Voucher[];
  ledgers: Ledger[];
  groups: Group[];
  voucherTypes: VoucherType[];
  stockItems: StockItem[];
  currencies: Currency[];

  trialBalance: ExecutedStatement;
  profitLoss: ExecutedStatement;
  balanceSheet: ExecutedStatement;
  receivables: ExecutedOutstanding;
  payables: ExecutedOutstanding;
  closingStock: ExecutedClosingStock;
  /**
   * Stock by storage location, from TallyPrime's Godown Summary REPORT.
   *
   * NOT a `Godown` collection. Collection types this server has never observed
   * park TallyPrime behind a modal dialog until somebody dismisses it — with
   * the exporter running unattended every minute on a machine somebody is
   * working on, that is the one failure this design must never cause. The
   * Godown Summary report ID is verified, so the locations come from there and
   * the workbook says which basis it used.
   */
  godowns: ExecutedClosingStock | null;

  /** Monthly cash flow, as TallyPrime's own report presents it. Null if refused. */
  cashFlow: ExecutedStatement | null;
  /** Monthly funds flow. Null if refused. */
  fundsFlow: ExecutedStatement | null;

  /**
   * TallyPrime's own register and exception views, each as it produced them.
   *
   * These are Tally's REPORTS rather than this server's procedures: the rule
   * deciding what appears on one is TallyPrime's, and their column meanings are
   * unverified for the ones no company has yet populated. Included because the
   * workbook's goal is completeness — if TallyPrime serves it and this
   * interface can read it, it is in the file — and each carries its own
   * warnings through to the Manifest.
   */
  reports: { key: ReportKey; title: string; report: ExecutedReport }[];

  /**
   * The three statements for EVERY book year, not just the current one.
   *
   * TallyPrime honours a statement end date only when it falls on the 31st of a
   * month — and every book year ends on one, whether the company runs to
   * 31 March or 31 December. So a per-year series is reachable, verified live
   * 2026-08-21: FY2024-25 came back with `coversPeriodRequested: true` and sales
   * of 6,344,808 against the current year's 44,573,583.
   *
   * The single-year statement tabs stay as they are. This is the series, so a
   * question about last year's gross margin has an answer.
   */
  statementsByYear: {
    year: DateRange;
    isCurrent: boolean;
    trialBalance: ExecutedStatement | null;
    profitLoss: ExecutedStatement | null;
    balanceSheet: ExecutedStatement | null;
  }[];

  /**
   * The master lists that needed an unobserved collection type — cost centres,
   * cost categories, godowns, units, stock groups, stock categories, budgets.
   *
   * Unreachable until 2026-08-21, when all seven types were re-probed against
   * TallyPrime 7.1 and accepted without a dialog. See
   * `normalizeSimpleMasters` for the evidence and for why the safety rule still
   * stands for any type NOT on that list.
   *
   * These are the REAL master lists, unlike the "used" tab derived from voucher
   * allocations — a cost centre defined and never posted to appears here and not
   * there.
   */
  simpleMasters: { type: SimpleMasterType; title: string; records: SimpleMaster[] }[];

  /** Every warning every fetch produced, in fetch order. Verbatim. */
  warnings: string[];
}

/**
 * TallyPrime's own report views that become tabs, and the tab each becomes.
 *
 * The order is the order they appear in the workbook. Names are kept under
 * Excel's 31-character sheet limit here rather than being truncated later,
 * where two long names could collide and take the whole file with them.
 */
/** What each master collection is called on its tab. */
const MASTER_TAB_TITLES: Record<SimpleMasterType, string> = {
  CostCentre: 'Cost centres',
  CostCategory: 'Cost categories',
  Godown: 'Godown masters',
  Unit: 'Units of measure',
  StockGroup: 'Stock groups',
  StockCategory: 'Stock categories',
  Budget: 'Budgets',
};

const REPORT_TABS: [ReportKey, string][] = [
  ['sales_register', 'Sales register'],
  ['purchase_register', 'Purchase register'],
  ['journal_register', 'Journal register'],
  ['negative_ledgers', 'Negative ledgers'],
  ['negative_stock', 'Negative stock'],
  ['bills_receivable', 'Bills receivable'],
  ['bills_payable', 'Bills payable'],
  ['cost_category_summary', 'Cost category summary'],
  ['ratio_analysis', 'Ratio analysis'],
];

/**
 * The same books, narrowed to the current book year.
 *
 * ## Why a second, smaller workbook exists at all
 *
 * The full workbook covers every year TallyPrime holds, which is what makes it
 * complete and also what makes it expensive to READ. Measured on MUDALS: 1.4MB,
 * 461,000 cells, of which **96% is multi-year transaction detail** — 2,738
 * vouchers over 67 columns, 10,640 GST rate-detail rows, 6,716 entry lines.
 * Reported from a real audit session, that file arrived as a 1.4MB base64 blob
 * too large to hold in context, and the questions being asked were about the
 * current and prior year anyway.
 *
 * So the history stays in the full file and a companion carries the year most
 * questions are about. Nothing is fetched twice: this filters records already in
 * hand, so the second workbook costs writing time and no TallyPrime time at all.
 *
 * ## What is NOT narrowed
 *
 * Only the voucher-derived tabs. The masters are a current list whatever period
 * is in view, and the statement tabs already cover the current book year — that
 * is the only period TallyPrime will honour for them. Filtering those would
 * change nothing except to make two files disagree.
 */
export function currentYearOnly(data: CompanyData): CompanyData {
  const { fromDate, toDate } = data.statementPeriod;

  return {
    ...data,
    // The span the narrowed file really covers, so its own Manifest reports the
    // truth rather than repeating the full file's period.
    period: data.statementPeriod,
    vouchers: data.vouchers.filter(
      // A voucher whose date Tally could not read is KEPT. Dropping it would be
      // deciding it belongs to another year, which is exactly what is unknown.
      (voucher) => voucher.date === null || (voucher.date >= fromDate && voucher.date <= toDate)
    ),
  };
}

/** One full fetch of the currency masters. */
async function fetchCurrencies(
  deps: ToolDeps,
  company: string | undefined
): Promise<{ currencies: Currency[]; warnings: string[] }> {
  const { data, warnings } = await fetchCollection<Currency>(deps, company, {
    build: buildCurrencyListRequest,
    normalize: (xml) => normalizeCurrencies(xml),
  });
  return { currencies: data, warnings };
}

/**
 * Read one company's books.
 *
 * Sequential throughout. TallyPrime's listener serves one request at a time and
 * the client queue would serialise these anyway, so awaiting in order costs
 * nothing and keeps a failure attributable to the fetch that caused it.
 *
 * A fetch that is not merely slow but IMPOSSIBLE on this company — a report the
 * build does not serve — must not take the whole workbook down with it, so the
 * optional ones are wrapped and their failure becomes a warning. The ones the
 * workbook cannot be honest without (vouchers, ledgers, the trial balance) are
 * NOT wrapped: a workbook missing its books should fail loudly rather than ship
 * looking complete.
 */
export async function collectCompany(
  deps: ToolDeps,
  companyName: string,
  now: Date
): Promise<CompanyData> {
  const warnings: string[] = [];

  const company = await companyNamed(deps, companyName);
  if (company === null) {
    throw new Error(
      `TallyPrime does not have "${companyName}" open, so nothing could be read for it. ` +
        'Open the company in TallyPrime, or correct the company list in Setup.'
    );
  }

  const currency = await resolveCompanyCurrencyDetailed(deps, company.name, warnings);

  /*
   * EVERY YEAR THE COMPANY HOLDS, not just the current one.
   *
   * A voucher COLLECTION is pinned to the current financial year and ignores the
   * dates asked for — that is why every tool defaults to it and why the workbook
   * used to say "current financial year only" on its Manifest. But
   * `fetchAcrossBookYears` routes years before the current one through the
   * `Voucher Register` REPORT, which does honour a date range (verified live
   * 2026-08-17: 14 vouchers for FY2023-24, 788 and 1,534 for the two years
   * after). So the history IS reachable; the export simply never asked for it.
   *
   * The cost is real and is the reason no interactive tool does this by default:
   * measured per book year, FY2023-24 was 880KB/0.3s, FY2024-25 39MB/27s and
   * FY2025-26 79MB/103s. A workbook is not an interactive question, though — it
   * is built when the books CHANGE, and read many times afterwards, so paying
   * minutes once is the right side of that trade.
   *
   * A year that times out is excluded with a loud warning rather than silently
   * dropped; `fetchAcrossBookYears` raises it and it reaches the Manifest.
   */
  const period = await resolvePeriodForCompany(deps, undefined, undefined, company.name);
  const fullSpan = {
    fromDate: company.startingFrom ?? period.fromDate,
    // The company's own last date where it has one, else the current book year's
    // end. Never "today": a company whose books stopped in July does not acquire
    // an empty August because somebody exported in August.
    toDate:
      company.endingAt !== null && company.endingAt > period.toDate
        ? company.endingAt
        : period.toDate,
  };

  /*
   * ALL FIELDS, unlike every tool that reads vouchers.
   *
   * A tool pays 18.3MB and ~6s for `allFields` and mostly uses the nested
   * structures, which the 8.6MB curated fetch already carries in identical
   * numbers (verified live 2026-08-13) — so the tools ask for nested only, and
   * they are right to.
   *
   * The workbook is a different question. Its goal is completeness: if
   * TallyPrime holds it and this interface can read it, it is in the file. The
   * curated fetch returns only the promoted scalars, so a lean export produces
   * a Vouchers tab with no reference numbers, due dates, GST fields or cost
   * centre names on it — measured on MUDALS, twelve columns where the full
   * fetch offers the company's own vocabulary.
   *
   * The cost is paid once per CHANGE rather than once per minute, which is the
   * whole point of the fingerprint check, and the fields that turn out to be
   * constant are relocated to the Tally defaults tab rather than repeated down
   * every row.
   */
  const vouchers = await fetchVouchers(deps, company.name, fullSpan, true);
  warnings.push(...vouchers.warnings);

  // All fields on the ledger masters: which fields a company populates IS the
  // interesting thing about its chart of accounts, and the uniform ones are
  // relocated to the Tally defaults tab rather than dropped.
  const ledgers = await fetchLedgers(deps, company.name, true);
  warnings.push(...ledgers.warnings);

  const groups = await fetchGroups(deps, company.name);
  warnings.push(...groups.warnings);

  const voucherTypes = await fetchVoucherTypes(deps, company.name);
  warnings.push(...voucherTypes.warnings);

  const stockItems = await fetchStockItems(deps, company.name, true);
  warnings.push(...stockItems.warnings);

  const currencies = await fetchCurrencies(deps, company.name);
  warnings.push(...currencies.warnings);

  const trialBalance = await executeStatement(deps, 'trial_balance', { company: company.name });
  warnings.push(...trialBalance.warnings);

  const profitLoss = await executeStatement(deps, 'profit_loss', { company: company.name });
  warnings.push(...profitLoss.warnings);

  const balanceSheet = await executeStatement(deps, 'balance_sheet', { company: company.name });
  warnings.push(...balanceSheet.warnings);

  // Ageing IS requested. The workbook cannot compute it afterwards — bill dates
  // live on nested allocations that the Receivables tab does not carry — and a
  // receivables tab with no ageing is the one an accountant would have to go
  // back to Tally for.
  const receivables = await executeOutstanding(deps, {
    side: 'receivable',
    company: company.name,
    includeAgeing: true,
    includeZeroBalances: true,
  });
  warnings.push(...receivables.warnings);

  const payables = await executeOutstanding(deps, {
    side: 'payable',
    company: company.name,
    includeAgeing: true,
    includeZeroBalances: true,
  });
  warnings.push(...payables.warnings);

  const closingStock = await executeClosingStock(deps, 'item', company.name);
  warnings.push(...closingStock.warnings);

  const godowns = await optional(deps, warnings, 'stock by storage location', () =>
    executeClosingStock(deps, 'godown', company.name)
  );
  warnings.push(...(godowns?.warnings ?? []));

  // TallyPrime's own monthly flow reports. Statements, so they go through the
  // same path — and optional, because a build that does not serve one must not
  // cost the workbook everything else.
  const cashFlow = await optional(deps, warnings, 'the cash flow report', () =>
    executeStatement(deps, 'cash_flow', { company: company.name })
  );
  warnings.push(...(cashFlow?.warnings ?? []));

  const fundsFlow = await optional(deps, warnings, 'the funds flow report', () =>
    executeStatement(deps, 'fund_flow', { company: company.name })
  );
  warnings.push(...(fundsFlow?.warnings ?? []));

  /*
   * The register and exception views, each as TallyPrime produced it.
   *
   * Every one is optional. Several are known to return nothing on companies
   * that do not use the feature — bills receivable and payable need bill-wise
   * accounting, negative stock needs inventory — and `ratio_analysis` is
   * accepted by Tally and returns no rows at all on every company measured. An
   * empty tab is a real answer; a failed fetch is not, and the two are told
   * apart by the warning `optional` leaves behind.
   */
  /*
   * The three statements, once per book year.
   *
   * `skipCurrentStateChecks` on every historical year. Those checks compare a
   * statement against the ledger masters and stock summary AS THEY ARE NOW,
   * which for a prior year is a comparison between two different periods — it
   * would emit a warning that reads like a discrepancy and is not one. It also
   * costs a full ledger and group fetch per year.
   *
   * The current year is taken from the statements already fetched above rather
   * than fetched again, so it keeps its cross-checks and costs nothing extra.
   */
  const years = bookYearsSpanning(
    fullSpan,
    company.startingFrom,
    company.startingFrom === null
      ? null
      : bookYearFor(company.startingFrom, company.endingAt ?? company.startingFrom)
  );

  /*
   * The master lists that need a collection TYPE.
   *
   * Each is `optional`: the types are verified safe on this build, but a build
   * that refuses one must not cost the workbook everything else. An empty list
   * is the company not using the feature and is reported as such.
   */
  const simpleMasters: CompanyData['simpleMasters'] = [];
  for (const type of SIMPLE_MASTER_TYPES) {
    const title = MASTER_TAB_TITLES[type];
    const fetched = await optional(deps, warnings, `the ${title.toLowerCase()} masters`, () =>
      fetchCollection<SimpleMaster>(deps, company.name, {
        build: (options) => buildSimpleMasterRequest(type, options),
        normalize: (xml) => normalizeSimpleMasters(xml, type.toUpperCase(), 'group', `the ${title.toLowerCase()} masters`),
      })
    );
    if (fetched === null) continue;
    warnings.push(...fetched.warnings);
    simpleMasters.push({ type, title, records: fetched.data });
  }

  const statementsByYear: CompanyData['statementsByYear'] = [];
  for (const year of years) {
    const isCurrent = year.fromDate === period.fromDate && year.toDate === period.toDate;

    if (isCurrent) {
      statementsByYear.push({ year, isCurrent, trialBalance, profitLoss, balanceSheet });
      continue;
    }

    const forYear = async (statement: 'trial_balance' | 'profit_loss' | 'balance_sheet') =>
      optional(deps, warnings, `the ${statement} for ${year.fromDate}..${year.toDate}`, () =>
        executeStatement(deps, statement, {
          company: company.name,
          fromDate: year.fromDate,
          toDate: year.toDate,
          skipCurrentStateChecks: true,
        })
      );

    statementsByYear.push({
      year,
      isCurrent,
      trialBalance: await forYear('trial_balance'),
      profitLoss: await forYear('profit_loss'),
      balanceSheet: await forYear('balance_sheet'),
    });
  }

  const reports: CompanyData['reports'] = [];
  for (const [key, title] of REPORT_TABS) {
    const report = await optional(deps, warnings, `the ${title} report`, () =>
      executeGenericReport(deps, { report: key, company: company.name })
    );
    if (report === null) continue;
    warnings.push(...report.warnings);
    reports.push({ key, title, report });
  }

  return {
    company,
    currency,
    // The span the VOUCHERS cover. The statement tabs are a different period —
    // they are the company's current book year, because a statement end date
    // only binds on a 31st. The Manifest states both rather than implying one.
    period: fullSpan,
    statementPeriod: period,
    asOf: now.toISOString(),
    vouchers: vouchers.vouchers,
    ledgers: ledgers.ledgers,
    groups: groups.groups,
    voucherTypes: voucherTypes.voucherTypes,
    stockItems: stockItems.items,
    currencies: currencies.currencies,
    godowns,
    cashFlow,
    fundsFlow,
    reports,
    simpleMasters,
    statementsByYear,
    trialBalance,
    profitLoss,
    balanceSheet,
    receivables,
    payables,
    closingStock,
    warnings,
  };
}

/**
 * Run a fetch the workbook can live without.
 *
 * Returns null and SAYS SO IN A WARNING rather than throwing. The warning is
 * the whole point: a tab that is absent because the fetch failed and a tab that
 * is absent because the company does not use the feature look identical in a
 * spreadsheet, and only one of them means "there is nothing to see here".
 *
 * Deliberately narrow — it applies only to tabs whose absence the Manifest can
 * state honestly. Nothing load-bearing goes through here.
 */
async function optional<T extends { warnings: string[] }>(
  deps: ToolDeps,
  warnings: string[],
  what: string,
  run: () => Promise<T>
): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    deps.logger.debug('optional export fetch failed', { what, error: String(error) });
    warnings.push(
      `COULD NOT READ ${what.toUpperCase()}: TallyPrime did not answer this request, so that ` +
        'tab is absent from this workbook. An absent tab here means the read FAILED — it does ' +
        `NOT mean the company has none. Technical detail: ${String(error)}`
    );
    return null;
  }
}
