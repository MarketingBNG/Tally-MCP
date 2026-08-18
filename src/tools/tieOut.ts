import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  companySchema,
  dateRangeSchema,
  PERIOD_NOTE,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
  verbositySchema,
} from '../schemas/common.js';
import { DEFAULT_CURRENCY, type Money } from '../utils/numbers.js';
import { bookYearFor, type DateRange } from '../utils/dates.js';
import { adaptAccounts, adaptVouchers } from '../model/fromTally.js';
import type { Account, SignedAmount, Voucher } from '../model/ledger.js';
import {
  assertCompanyIsLoaded,
  companyNamed,
  resolveCompanyCurrencyDetailed,
  resolvePeriod,
  runTool,
  whole,
  type ToolDeps,
} from './toolResult.js';
import { highestSeverity, summariseFindings, type Finding } from './findings.js';
import { TallyError } from '../tally/TallyError.js';
import { fetchLedgers } from './ledgers.js';
import { fetchGroups } from './groups.js';
import { fetchVouchers } from './vouchers.js';
import { fetchStockItems } from './inventory.js';
import type { StockItem } from '../tally/normalize.js';

/**
 * Tie-out: does the arithmetic in these books actually hold?
 *
 * Build Specification v1.0 §1 makes this outcome 3 — "books tie" — and §4 L5
 * makes `tie_out_gate` a BLOCKING control: nothing goes to a client until it
 * passes. This tool is the first working piece of that gate, and it is the
 * cheapest one to build, because it needs no warehouse: both sides of the
 * comparison are already retrievable from TallyPrime.
 *
 * Two checks, deliberately independent of each other.
 *
 * 1. **Double entry.** Every voucher's debits must equal its credits. Needs no
 *    balances at all, so it works even where opening balances are missing, and
 *    an unbalanced voucher is a hard finding under any framework.
 *
 * 2. **Balance roll-forward.** For each ledger, opening balance plus the
 *    period's movements must equal the closing balance TallyPrime reports.
 *    This is the same arithmetic `tally_get_ledger_transactions` performs for
 *    a single ledger, applied across every ledger at once — which is what
 *    turns a spot check into a control.
 *
 * WRITTEN AGAINST THE MODEL, NOT AGAINST TALLY. Everything below operates on
 * `src/model/ledger.ts` types, reached through the adapter. That is not
 * ceremony: Annexure A §3.3 requires every audit test to be written once,
 * against the normalised model, and this is the first test to do it. When a
 * Zoho Books or QuickBooks adapter appears, this file should not need to
 * change at all. If it does, the model is wrong.
 *
 * NO LLM ARITHMETIC (§6 rule 1). Every figure here is computed in Decimal and
 * returned with the inputs that produced it, so the model reports a number it
 * was given rather than one it worked out.
 */

const DESCRIPTION = [
  'Check that the books tie: every voucher balances, every ledger closing balance equals its ' +
    'opening balance plus the movements in the period, and the stock figure in the accounts ' +
    'agrees with the stock records.',
  '',
  'WHEN TO USE: before relying on ANY figure from these books for a report, a workpaper or a ' +
    'client deliverable. Run it first and quote the result. If it fails, the numbers from every ' +
    'other tool are suspect and should not be presented until the exceptions are explained.',
  '',
  'RETURNS: a pass/fail verdict, then counts of what was checked, then the exceptions ' +
    'themselves — unbalanced vouchers with the amount they are out by, ledgers whose ' +
    'computed closing balance disagrees with the one TallyPrime reports, and any date at which ' +
    'stock per the general ledger disagrees with stock per the stock records, each showing both ' +
    'figures and the difference.',
  '',
  'THE STOCK TIE-OUT IS CHECKED AT BOTH ENDS of the period, and the two mean different things. ' +
    'A difference at OPENING was already wrong before the period began — an opening-balance or ' +
    'conversion error. A difference at CLOSING only means stock moved in the stock records ' +
    'without a matching entry reaching the general ledger, which makes cost of sales wrong by ' +
    'that amount. Reporting only the closing gap would merge the two into one figure and hide ' +
    'both causes. Where nothing could be tied, `checks.stockTieOut.applicable` is false and ' +
    '`notApplicableReason` says WHICH of three states it is — the company keeps no inventory, ' +
    'or it holds stock records but no stock ledger to tie them against, or a stock ledger with ' +
    'no stock records behind it. Only the first is benign: the second means inventory is ' +
    'unconstrained by double entry and an error in it would reach the accounts unchallenged. ' +
    'Report which one rather than calling any of them a pass.',
  '',
  'HOW THE COMPARISON WORKS, and its one real limitation: the closing balance TallyPrime ' +
    'reports for a ledger is as at TALLY OWN CURRENT PERIOD END, not the end of the range asked ' +
    'for here. So the roll-forward check is only meaningful when the range covers the company ' +
    'whole period. Given no dates, this tool defaults to the financial year the company books ' +
    'begin in — NOT the financial year containing today, which is what the other tools default ' +
    'to — because that is the range most likely to line up. Given explicit dates, it checks them ' +
    'and warns that a partial range will disagree for reasons that are not errors.',
  '',
  'NOT CHECKABLE is reported separately from FAILED, and the distinction matters: a ledger with ' +
    'no opening balance, or a voucher carrying an unreadable amount, cannot be verified either ' +
    'way. Counting those as passes would overstate the assurance this gives.',
  '',
  'SEVERAL COMPANIES AT ONCE: pass `companies: ["A", "B"]` instead of `company` to check each ' +
    'in one call. Every company is checked against its OWN books and its own book year; nothing ' +
    'is totalled across them. The overall `passed` is true only if all of them pass.',
  '',
  'FINDINGS: alongside the prose warnings, every result carries `findings` — typed objects with ' +
    'a severity ("exception" for books that are out, "not_checkable" for what could not be ' +
    'verified, "info"), a stable `code`, the subject, and the figures behind it. Triage on those ' +
    'rather than by reading the warning text. `findingCounts` and `highestSeverity` summarise them.',
  '',
  'VERBOSITY: pass verbosity "summary" to drop the standing explanatory notes and return only ' +
    'the findings, with a count of what was omitted. Exceptions are never suppressed.',
  '',
  PERIOD_NOTE,
  '',
  'PAGINATION: not applicable — exceptions are returned in full, because a truncated exception ' +
    'register is not a control.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

/**
 * A signed amount as a single number, for arithmetic only.
 *
 * Debit positive, credit negative — the ordinary accounting convention, and
 * deliberately NOT Tally's (which encodes a debit as negative). Both sides of
 * every comparison below go through this same function, so the choice cancels
 * out; what matters is that it is applied once, consistently, and that nothing
 * signed ever leaves this module. Results are converted back to an explicit
 * side before they are returned.
 */
function asDecimal(amount: SignedAmount | null): Decimal | null {
  if (amount === null) return null;
  const magnitude = new Decimal(amount.magnitude.amount);
  return amount.side === 'debit' ? magnitude : magnitude.negated();
}

/** Back to the model's explicit-side form. */
function toSigned(value: Decimal, currency: string): SignedAmount {
  return {
    magnitude: { amount: value.abs().toFixed(), currency },
    side: value.isNegative() ? 'credit' : 'debit',
  };
}

export interface VoucherImbalance {
  voucherId: string;
  date: string | null;
  number: string | null;
  voucherType: string | null;
  /** How far off balance the voucher is. Never zero — a zero is not a finding. */
  outBy: SignedAmount;
  entryCount: number;
}

export interface BalanceException {
  account: string;
  path: string[];
  opening: SignedAmount | null;
  /** Opening plus this period's movements, computed here. */
  computedClosing: SignedAmount;
  /** What TallyPrime reports, as at its own period end. */
  reportedClosing: SignedAmount | null;
  difference: SignedAmount;
  movementCount: number;
}

/**
 * Inventory per the general ledger against inventory per the stock records.
 *
 * Reported at BOTH ends of the period, because the two ends mean different
 * things and a single closing comparison conflates them — which is exactly how
 * this was first mis-diagnosed.
 */
export interface StockTieOutException {
  /** 'opening' or 'closing' — which end of the period disagrees. */
  at: 'opening' | 'closing';
  /** The stock ledger(s) in the general ledger, and their total. */
  perGeneralLedger: SignedAmount;
  /** The stock item masters, and their total. */
  perStockRecords: SignedAmount;
  difference: SignedAmount;
  ledgersIncluded: string[];
  stockItemsIncluded: number;
}

/**
 * Does the stock figure in the accounts agree with the stock records?
 *
 * WHY THIS IS A TIE-OUT AND NOT A WARNING. Inventory is the one balance that
 * exists twice in every set of books: once as a general-ledger account, and
 * once as the sum of the stock ledger. In an integrated system they are the
 * same number by construction. Where they are not, the accounts carry a stock
 * figure that ties to nothing countable, and every margin drawn from them is
 * wrong by the difference. That is an arithmetic control, which is what this
 * tool is for — not a caveat on one report.
 *
 * BOTH ENDS, DELIBERATELY. Found live 2026-08-18 on AgEx Pharma LLC, and the
 * decomposition is the whole point:
 *
 *   stock records   273,909.89 opening -> 239,687.94 closing  (34,221.95 used)
 *   general ledger  304,588.00 opening -> 304,588.00 closing  (no movement)
 *
 * A closing-only check reports one number, 64,900.06, and invites the reading
 * "closing stock is stale". Checking both ends splits it into two unrelated
 * faults: 30,678.11 was ALREADY wrong before the period began, and 34,221.95
 * is stock consumed in the period that never reached the general ledger. The
 * first is an opening-balance error, the second an integration failure, and
 * they have different owners and different fixes. Reporting their sum as one
 * figure would have hidden both.
 *
 * NOTHING IS ADJUSTED and neither side is preferred. Both are the accounting
 * system's own figures; which one is right is a judgement that needs the
 * stock count, and this says so rather than picking.
 *
 * A company with no stock ledgers and no stock items is not an exception — it
 * keeps no inventory, and there is nothing to tie. It returns no exceptions
 * and a `checked` of zero, which the caller reports as "not applicable"
 * rather than as a pass.
 */
export function checkStockTieOut(
  /** Postable accounts whose group marks them as stock in hand. */
  stockAccounts: readonly Account[],
  /** Stock item masters, carrying their own opening and closing values. */
  stockItems: readonly { name: string; openingValue: Money | null; closingValue: Money | null }[],
  fallbackCurrency: string = DEFAULT_CURRENCY
): {
  exceptions: StockTieOutException[];
  checked: number;
  notCheckable: string[];
  /**
   * Why nothing was tied, when nothing was. Null when the check ran.
   *
   * THREE STATES HIDE BEHIND "checked: 0", and reporting one answer for all
   * of them is the same fault this file's stock check exists to catch. Found
   * live 2026-08-18: MUDALS keeps no inventory, while AGBV Nutrition GmbH
   * holds 13 stock items with real movement (MCT Oil 17,100 -> 9,500 Kg) and
   * has NO stock ledger in its general ledger at all. Both returned "not
   * applicable", which reads as "nothing to see" on a company where inventory
   * is simply absent from the accounts.
   */
  notApplicableReason: string | null;
} {
  const notCheckable: string[] = [];

  if (stockItems.length === 0 && stockAccounts.length === 0) {
    return {
      exceptions: [],
      checked: 0,
      notCheckable,
      notApplicableReason:
        'This company records no stock items and carries no stock ledger, so it keeps no ' +
        'inventory and there is nothing to tie. This is neither a pass nor a failure.',
    };
  }

  if (stockAccounts.length === 0) {
    return {
      exceptions: [],
      checked: 0,
      notCheckable,
      notApplicableReason:
        `This company holds ${String(stockItems.length)} stock item(s) but has NO stock ledger ` +
        'in its general ledger, so there is no independent general-ledger figure to tie the ' +
        'stock records against. TallyPrime still shows a Stock-in-Hand total on the balance ' +
        'sheet, but it derives that from the inventory valuation rather than from a posted ' +
        'balance — the two cannot disagree because they are the same number. Inventory is ' +
        'therefore UNTIED here, not verified: the stock records are unconstrained by double ' +
        'entry, and an error in them would reach the accounts unchallenged.',
    };
  }

  if (stockItems.length === 0) {
    return {
      exceptions: [],
      checked: 0,
      notCheckable,
      notApplicableReason:
        `The general ledger carries ${String(stockAccounts.length)} stock ledger(s) but this ` +
        'company records NO stock items, so the accounts assert a stock figure that no stock ' +
        'record supports. Establish what the balance represents before relying on it.',
    };
  }

  /**
   * THE TWO SIDES ARRIVE IN DIFFERENT SIGN CONVENTIONS, and comparing them
   * raw would produce a difference of roughly twice the balance on books that
   * actually agree.
   *
   * - Accounts come through the model adapter, whose `SignedAmount` carries an
   *   explicit side; `asDecimal` renders that debit-positive.
   * - Stock item masters are passed through from TallyPrime untouched, and
   *   Tally encodes a debit NEGATIVE — verified live, stock in hand arrives as
   *   -20000.00 and similar.
   *
   * Both describe the same thing: stock held, an asset, a debit. So both are
   * reduced to a MAGNITUDE and compared as magnitudes. Nothing is re-signed,
   * and no sign is corrected in either source.
   */
  const glMagnitude = (amount: SignedAmount | null): Decimal | null => {
    const value = asDecimal(amount);
    return value === null ? null : value.abs();
  };

  /**
   * Sum one side, refusing to total a set with a hole in it.
   *
   * A null is the accounting system reporting nothing, which is not a zero —
   * §6 rule 1. Skipping it would produce a total short by an unknown amount
   * and then compare it, manufacturing a difference that is an artefact of the
   * missing value rather than a fact about the books.
   */
  const totalOf = (values: readonly (Decimal | null)[], label: string): Decimal | null => {
    let total = new Decimal(0);
    for (const value of values) {
      if (value === null) {
        notCheckable.push(
          `${label} could not be totalled: at least one value was absent, and a missing figure ` +
            'is not a zero. The stock tie-out was not performed at this date.'
        );
        return null;
      }
      total = total.plus(value);
    }
    return total;
  };

  // The currency to label results with. Taken from the accounts, which have
  // been through the currency resolution the rest of this tool uses.
  const currency =
    stockAccounts[0]?.openingBalance?.magnitude.currency ??
    stockAccounts[0]?.closingBalance?.magnitude.currency ??
    fallbackCurrency;

  const exceptions: StockTieOutException[] = [];
  let checked = 0;

  for (const at of ['opening', 'closing'] as const) {
    const gl = totalOf(
      stockAccounts.map((account) =>
        glMagnitude(at === 'opening' ? account.openingBalance : account.closingBalance)
      ),
      `The general-ledger stock ${at} balance`
    );
    const records = totalOf(
      stockItems.map((item) => {
        const value = at === 'opening' ? item.openingValue : item.closingValue;
        if (value === null || value.amount === null) return null;
        return new Decimal(value.amount).abs();
      }),
      `The stock records ${at} value`
    );
    if (gl === null || records === null) continue;

    checked += 1;
    const difference = gl.minus(records);
    // Below a rounding floor the two are the same figure, not a finding.
    if (difference.abs().lessThanOrEqualTo(new Decimal(TIE_OUT_TOLERANCE))) continue;

    exceptions.push({
      at,
      perGeneralLedger: toSigned(gl, currency),
      perStockRecords: toSigned(records, currency),
      difference: toSigned(difference, currency),
      ledgersIncluded: stockAccounts.map((account) => account.name),
      stockItemsIncluded: stockItems.length,
    });
  }

  return { exceptions, checked, notCheckable, notApplicableReason: null };
}

/** Rounding floor for the stock tie-out, in currency units. */
const TIE_OUT_TOLERANCE = '0.01';

/**
 * Check every voucher balances.
 *
 * A voucher whose entries cannot all be read is reported as not checkable
 * rather than as balanced: the entries that ARE readable might sum to zero by
 * coincidence, and calling that a pass would be a false assurance.
 */
export function checkDoubleEntry(
  vouchers: readonly Voucher[],
  /**
   * Label for amounts whose own currency could not be read. Defaults to INR
   * only for callers that predate currency resolution; the tool passes the
   * company's resolved currency, so a euro company's imbalance is not
   * reported in rupees.
   */
  fallbackCurrency: string = DEFAULT_CURRENCY
): {
  imbalances: VoucherImbalance[];
  checked: number;
  notCheckable: string[];
} {
  const imbalances: VoucherImbalance[] = [];
  const notCheckable: string[] = [];
  let checked = 0;

  for (const voucher of vouchers) {
    // A cancelled voucher posts nothing, so it has no balancing obligation.
    // It is retained in the data and skipped here, not filtered upstream.
    if (voucher.isCancelled || voucher.lines.length === 0) continue;

    let total = new Decimal(0);
    let readable = true;
    let currency = fallbackCurrency;

    for (const line of voucher.lines) {
      const value = asDecimal(line.amount);
      if (value === null) {
        readable = false;
        break;
      }
      currency = line.amount?.magnitude.currency ?? currency;
      total = total.plus(value);
    }

    if (!readable) {
      notCheckable.push(
        `Voucher ${voucher.number ?? voucher.id} carries an entry with an unreadable amount, so it cannot be confirmed to balance.`
      );
      continue;
    }

    checked += 1;
    if (!total.isZero()) {
      imbalances.push({
        voucherId: voucher.id,
        date: voucher.date,
        number: voucher.number,
        voucherType: voucher.sourceType,
        outBy: toSigned(total, currency),
        entryCount: voucher.lines.length,
      });
    }
  }

  return { imbalances, checked, notCheckable };
}

/**
 * Accounts whose closing balance TallyPrime DERIVES rather than posts, so
 * opening-plus-movements can never reconcile to it.
 *
 * Verified live 2026-08-13. `Stock In Hand` had a closing balance of 304,588
 * against an opening of 207,968 and **zero** ledger postings in the year — its
 * value comes from inventory valuation, not journal entries. `Profit & Loss A/c`
 * is reported by Tally as nil at both ends while its real figure is the
 * accumulation of the revenue and expense accounts.
 *
 * Reporting these as exceptions is a false positive on books that balance, and a
 * blocking control that cries wolf gets ignored. They belong in `notCheckable`:
 * the roll-forward test simply does not apply to them, which is a different
 * statement from "these books are out".
 */
function derivedBalanceReason(account: Account): string | null {
  // Tally pads its primary-group name with a leading space, so compare trimmed.
  const path = account.path.map((step) => step.trim().toLowerCase());

  if (path.includes('stock-in-hand')) {
    return 'its closing balance comes from inventory valuation rather than ledger postings, so opening plus movements cannot reconcile to it';
  }
  if (account.name.trim().toLowerCase() === 'profit & loss a/c') {
    return 'TallyPrime derives this account from the revenue and expense accounts rather than posting to it';
  }

  return null;
}

/**
 * Check opening + movements = closing, for every postable account.
 *
 * Only postable accounts are checked. A group heading carries no balance of
 * its own in this model, and rolling children up into it would be testing this
 * server's own summation rather than Tally's books.
 */
export function checkBalanceRollForward(
  accounts: readonly Account[],
  vouchers: readonly Voucher[],
  /** See `checkDoubleEntry` — the company's currency, not an assumed INR. */
  fallbackCurrency: string = DEFAULT_CURRENCY
): { exceptions: BalanceException[]; checked: number; notCheckable: string[] } {
  const exceptions: BalanceException[] = [];
  const notCheckable: string[] = [];
  let checked = 0;

  // Movements per account, accumulated once rather than re-scanned per
  // account: a mid-sized company has thousands of vouchers and hundreds of
  // ledgers, and the naive form is that product.
  const movements = new Map<string, { total: Decimal; count: number; readable: boolean }>();

  for (const voucher of vouchers) {
    if (voucher.isCancelled || voucher.isDraft) continue;

    for (const line of voucher.lines) {
      const key = line.accountId.toLowerCase();
      const entry = movements.get(key) ?? { total: new Decimal(0), count: 0, readable: true };
      const value = asDecimal(line.amount);

      if (value === null) entry.readable = false;
      else entry.total = entry.total.plus(value);

      entry.count += 1;
      movements.set(key, entry);
    }
  }

  for (const account of accounts) {
    if (!account.isPostable) continue;

    const derived = derivedBalanceReason(account);
    if (derived !== null) {
      notCheckable.push(`"${account.name}" cannot be rolled forward: ${derived}.`);
      continue;
    }

    const movement = movements.get(account.name.toLowerCase());
    const opening = asDecimal(account.openingBalance);
    const reported = asDecimal(account.closingBalance);
    const currency =
      account.openingBalance?.magnitude.currency ??
      account.closingBalance?.magnitude.currency ??
      fallbackCurrency;

    if (opening === null || reported === null) {
      // Only worth reporting where there was activity — a dormant ledger with
      // no balances and no movements is not an audit finding, it is an empty
      // account, and listing every one of them would bury the real ones.
      if (movement !== undefined && movement.count > 0) {
        notCheckable.push(
          `"${account.name}" has ${String(movement.count)} movement(s) in the period but TallyPrime reported no ${opening === null ? 'opening' : 'closing'} balance, so it cannot be rolled forward.`
        );
      }
      continue;
    }

    if (movement?.readable === false) {
      notCheckable.push(
        `"${account.name}" has an entry with an unreadable amount, so its closing balance cannot be verified.`
      );
      continue;
    }

    checked += 1;

    const computed = opening.plus(movement?.total ?? new Decimal(0));
    const difference = computed.minus(reported);

    // To the paisa, per §1 outcome 3. No tolerance: a rounding allowance here
    // would be this server deciding what counts as immaterial, which is a
    // judgement reserved to the engagement team.
    if (!difference.isZero()) {
      exceptions.push({
        account: account.name,
        path: account.path,
        opening: account.openingBalance,
        computedClosing: toSigned(computed, currency),
        reportedClosing: account.closingBalance,
        difference: toSigned(difference, currency),
        movementCount: movement?.count ?? 0,
      });
    }
  }

  return { exceptions, checked, notCheckable };
}

/** Total of every imbalance, so the scale of the problem is visible at a glance. */
function sumOf(amounts: readonly SignedAmount[], fallbackCurrency: string): Money {
  const total = amounts.reduce(
    (running, amount) => running.plus(asDecimal(amount) ?? new Decimal(0)),
    new Decimal(0)
  );
  return {
    amount: total.abs().toFixed(),
    currency: amounts[0]?.magnitude.currency ?? fallbackCurrency,
  };
}

/** One company's tie-out result, so a batch run and a single run share a shape. */
interface CompanyTieOut {
  company: string | null;
  passed: boolean;
  period: DateRange;
  currency: string;
  payload: Record<string, unknown>;
  findings: Finding[];
  exceptionCount: number;
  /**
   * Notes that explain normal behaviour rather than report a problem. Held
   * separately from `findings` so `verbosity: "summary"` has something safe
   * to drop — nothing in here indicates a wrong figure.
   */
  informationalNotes: string[];
}

/**
 * Run the tie-out for exactly one company.
 *
 * Split out so the batch path and the single-company path cannot drift: both
 * call this, and a fix to the arithmetic lands in both at once.
 */
async function tieOutOneCompany(
  deps: ToolDeps,
  companyArg: string | undefined,
  dates: { fromDate?: string | undefined; toDate?: string | undefined }
): Promise<CompanyTieOut> {
  // own financial year rather than the one containing today. The
  // roll-forward compares against Tally's period-end closing balance, so
  // a range that does not cover the company's period disagrees for
  // reasons that are not errors — and this tool's whole value is that a
  // disagreement means something.
  const explicitDates = dates.fromDate !== undefined || dates.toDate !== undefined;
  let period = resolvePeriod(dates.fromDate, dates.toDate);

  // Notes that merely explain normal behaviour. Separated from findings so
  // `verbosity: "summary"` can drop them without touching anything that
  // reports a problem.
  const periodNotes: string[] = [];
  const findings: Finding[] = [];

  if (!explicitDates) {
    // By name where one was given. With several companies loaded and none
    // named, this resolves to null and the note below fires — which is
    // right: their book years differ, so picking the first company's year
    // would check a period the company never closed against.
    const company = await companyNamed(deps, companyArg);
    const startingFrom = company === null ? null : company.startingFrom;

    if (company === null) {
      // Several companies loaded and none named. Their book years differ
      // — a German calendar year against two April years, live — so
      // there is no "the company's year" to default to, and picking one
      // would check a period that company never closed against.
      //
      // A finding, not a note: the period may be wrong, which makes every
      // roll-forward difference below unreliable. That must survive summary.
      findings.push({
        severity: 'not_checkable',
        code: 'period_not_anchored_to_book_year',
        subject: null,
        company: companyArg ?? null,
        message:
          'No dates were given and TallyPrime has more than one company loaded, so whose book ' +
          'year to use could not be determined. The period defaults to the financial year ' +
          'containing today, which may not be any of their years — name a company to check ' +
          'against its own. The roll-forward below will report differences that are not ' +
          'errors if the period is wrong.',
        figures: { fromDate: period.fromDate, toDate: period.toDate },
      });
    } else if (startingFrom === null) {
      findings.push({
        severity: 'not_checkable',
        code: 'period_not_anchored_to_book_year',
        subject: company.name,
        company: company.name,
        message:
          'TallyPrime did not report when this company books begin, so the period defaults to ' +
          'the financial year containing today. If that is not the company own year, the ' +
          'roll-forward check below will report differences that are not errors.',
        figures: { fromDate: period.fromDate, toDate: period.toDate },
      });
    } else {
      // Anchored on the company's own start month, not on 1 April. A
      // company whose books run January to December gets its January year;
      // assuming April would pick a window that need not even contain the
      // company's own data, and this tool's entire value rests on the
      // period being the one Tally closed against.
      period = bookYearFor(startingFrom, company.endingAt ?? startingFrom);
      periodNotes.push(
        `No dates were given, so this checked ${period.fromDate} to ${period.toDate} — the company's own book year, twelve months from the date its books begin.`
      );
    }
  } else {
    periodNotes.push(
      'Explicit dates were given. TallyPrime reported closing balances are as at its own period end, not the end of this range, so the balance roll-forward will show differences wherever the range does not cover the whole period. Those are not necessarily errors.'
    );
  }

  // Resolved so the figures below carry the company's own currency rather
  // than the INR default this file used to assume — the same wrong-label
  // bug fixed elsewhere on 2026-08-13, which this tool had kept.
  const currencyWarnings: string[] = [];
  const currency = await resolveCompanyCurrencyDetailed(deps, companyArg, currencyWarnings);

  const [{ ledgers, warnings: ledgerWarnings }, { groups, warnings: groupWarnings }] =
    await Promise.all([fetchLedgers(deps, companyArg), fetchGroups(deps, companyArg)]);

  const { vouchers, warnings: voucherWarnings } = await fetchVouchers(deps, companyArg, period);

  // Stock items are the second half of the inventory tie-out. Fetched
  // unconditionally rather than only where a stock ledger exists, because
  // "the general ledger carries no stock account but the stock records hold
  // 240,000" is itself the finding, and a conditional fetch could never see it.
  /**
   * Never allowed to fail the tie-out.
   *
   * The double-entry and roll-forward checks stand on their own and are the
   * blocking control (§4 L5). If the stock fetch errors — an older TallyPrime,
   * a company with inventory switched off, a transport fault — losing those
   * two results as well would turn a partial answer into no answer, which is
   * the opposite of what a gate should do. A failure here degrades to "not
   * checkable" and is reported as such, matching how this file already treats
   * a ledger it cannot roll forward.
   */
  const stock = await (async (): Promise<{ items: StockItem[]; warnings: string[]; note: string | null }> => {
    try {
      const { items, warnings } = await fetchStockItems(
        deps,
        companyArg,
        // Curated fields only: this needs opening and closing value, both of
        // which are named properties. All-fields is several times the payload.
        false
      );
      return { items, warnings, note: null };
    } catch (error) {
      return {
        items: [],
        warnings: [],
        note:
          'The stock records could not be read, so inventory was not tied out. The other checks ' +
          `below are unaffected. Reason: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  })();
  const stockItems = stock.items;
  const stockWarnings = stock.warnings;

  const entityId = companyArg ?? 'loaded-company';
  const accounts = adaptAccounts(groups, ledgers, { entityId });
  const adapted = adaptVouchers(vouchers, { entityId });

  const doubleEntry = checkDoubleEntry(adapted.data, currency.label);
  const rollForward = checkBalanceRollForward(accounts.data, adapted.data, currency.label);

  // Stock-in-hand accounts, by the group TallyPrime files them under. Matched
  // on the PATH rather than the immediate parent so a company that nests its
  // stock ledgers a level deeper is still caught.
  const stockAccounts = accounts.data.filter(
    (account) =>
      account.isPostable &&
      account.path.some((step) => step.trim().toLowerCase() === 'stock-in-hand')
  );
  const stockTieOut = checkStockTieOut(stockAccounts, stockItems, currency.label);
  if (stock.note !== null) stockTieOut.notCheckable.push(stock.note);

  const passed =
    doubleEntry.imbalances.length === 0 &&
    rollForward.exceptions.length === 0 &&
    stockTieOut.exceptions.length === 0;

  // Every exception becomes a typed finding as well as staying in its own
  // list. The lists keep the full record; the findings make severity
  // explicit so a caller can triage without parsing prose.
  for (const item of doubleEntry.imbalances) {
    findings.push({
      severity: 'exception',
      code: 'voucher_out_of_balance',
      subject: item.number ?? item.voucherId,
      company: companyArg ?? null,
      message:
        `Voucher ${item.number ?? item.voucherId} does not balance: its debits and credits ` +
        `differ by ${item.outBy.magnitude.amount} ${item.outBy.magnitude.currency} ` +
        `(${item.outBy.side}), across ${String(item.entryCount)} entries.`,
      figures: {
        outBy: item.outBy,
        entryCount: item.entryCount,
        date: item.date,
        voucherType: item.voucherType,
      },
    });
  }

  for (const item of rollForward.exceptions) {
    findings.push({
      severity: 'exception',
      code: 'balance_roll_forward_mismatch',
      subject: item.account,
      company: companyArg ?? null,
      message:
        `"${item.account}" does not roll forward: opening plus ${String(item.movementCount)} ` +
        `movement(s) computes to ${item.computedClosing.magnitude.amount} ` +
        `${item.computedClosing.magnitude.currency} (${item.computedClosing.side}), but ` +
        `TallyPrime reports ${item.reportedClosing?.magnitude.amount ?? 'no closing balance'}` +
        `${item.reportedClosing === null ? '' : ` ${item.reportedClosing.magnitude.currency} (${item.reportedClosing.side})`}` +
        ` — a difference of ${item.difference.magnitude.amount} ` +
        `${item.difference.magnitude.currency} (${item.difference.side}).`,
      figures: {
        opening: item.opening,
        computedClosing: item.computedClosing,
        reportedClosing: item.reportedClosing,
        difference: item.difference,
        movementCount: item.movementCount,
      },
    });
  }

  for (const item of stockTieOut.exceptions) {
    const movement =
      item.at === 'opening'
        ? 'This is an OPENING position, so it was already wrong before the period began — an ' +
          'opening-balance or conversion error, not something this period caused.'
        : 'This is the CLOSING position. Where the opening ties and the closing does not, stock ' +
          'moved in the stock records without a corresponding entry reaching the general ' +
          'ledger, and cost of sales is wrong by the difference.';
    findings.push({
      severity: 'exception',
      code: 'stock_does_not_tie',
      subject: item.ledgersIncluded.join(', '),
      company: companyArg ?? null,
      message:
        `Inventory does not tie at ${item.at}: the general ledger carries ` +
        `${item.perGeneralLedger.magnitude.amount} ${item.perGeneralLedger.magnitude.currency} ` +
        `across ${String(item.ledgersIncluded.length)} stock ledger(s), while the stock records ` +
        `for ${String(item.stockItemsIncluded)} item(s) total ` +
        `${item.perStockRecords.magnitude.amount} — a difference of ` +
        `${item.difference.magnitude.amount}. ${movement} Neither figure has been adjusted and ` +
        'neither is preferred: which is right needs the stock count.',
      figures: {
        at: item.at,
        perGeneralLedger: item.perGeneralLedger,
        perStockRecords: item.perStockRecords,
        difference: item.difference,
        ledgersIncluded: item.ledgersIncluded.join(', '),
        stockItemsIncluded: item.stockItemsIncluded,
      },
    });
  }

  /**
   * Inventory that was not tied is reported, not passed over in silence.
   *
   * Severity is not_checkable rather than info: "the stock records are
   * unconstrained by double entry" is a limitation on the assurance this gate
   * gives, and a limitation that only appears at full verbosity is a
   * limitation nobody reads. It does not fail the tie-out — nothing is known
   * to be wrong — but it must not read as a clean stock result either.
   */
  if (stockTieOut.notApplicableReason !== null) {
    findings.push({
      severity: 'not_checkable',
      code: 'stock_not_tied',
      subject: null,
      company: companyArg ?? null,
      message: stockTieOut.notApplicableReason,
      figures: {
        stockLedgers: stockAccounts.length,
        stockItems: stockItems.length,
      },
    });
  }

  for (const reason of [
    ...doubleEntry.notCheckable,
    ...rollForward.notCheckable,
    ...stockTieOut.notCheckable,
  ]) {
    findings.push({
      severity: 'not_checkable',
      code: 'not_checkable',
      subject: null,
      company: companyArg ?? null,
      message: reason,
    });
  }

  // A currency that was not established is a finding, not a note: every
  // figure in this response carries that label, so a reader needs it even
  // in summary form.
  if (!currency.comparable) {
    for (const message of currencyWarnings) {
      findings.push({
        severity: 'not_checkable',
        code: 'currency_not_established',
        subject: companyArg ?? null,
        company: companyArg ?? null,
        message,
        figures: { currency: currency.label, source: currency.source },
      });
    }
  }

  const payload: Record<string, unknown> = {
    /**
     * The gate. Spec §4 L5: a failure blocks output. This server
     * cannot enforce that, so it states it plainly instead and the
     * tool description tells Claude not to present figures over it.
     */
    passed,
    period,
    currency: currency.label,
    /** False when the label was inferred or absent rather than established. */
    currencyEstablished: currency.comparable,
    checks: {
      doubleEntry: {
        description: 'Every voucher debits equal its credits.',
        vouchersChecked: doubleEntry.checked,
        exceptions: doubleEntry.imbalances.length,
        ...(doubleEntry.imbalances.length === 0
          ? {}
          : {
              totalOutBy: sumOf(
                doubleEntry.imbalances.map((item) => item.outBy),
                currency.label
              ),
            }),
      },
      balanceRollForward: {
        description:
          'Opening balance plus period movements equals the closing balance TallyPrime reports.',
        accountsChecked: rollForward.checked,
        exceptions: rollForward.exceptions.length,
        ...(rollForward.exceptions.length === 0
          ? {}
          : {
              totalDifference: sumOf(
                rollForward.exceptions.map((item) => item.difference),
                currency.label
              ),
            }),
      },
      stockTieOut: {
        description:
          'Stock in the general ledger equals the stock records, at both ends of the period.',
        /**
         * Zero means NOT APPLICABLE, not "passed". A company with no stock
         * ledgers and no stock items has nothing to tie; counting that as a
         * pass would report assurance nobody obtained.
         */
        datesChecked: stockTieOut.checked,
        applicable: stockTieOut.checked > 0,
        exceptions: stockTieOut.exceptions.length,
        /**
         * Present only when nothing was tied. Says WHICH of the three
         * not-applicable states this is — no inventory at all, stock records
         * with no ledger to tie them to, or a ledger with no stock records —
         * because they carry very different amounts of assurance.
         */
        ...(stockTieOut.notApplicableReason === null
          ? {}
          : { notApplicableReason: stockTieOut.notApplicableReason }),
      },
    },
    unbalancedVouchers: doubleEntry.imbalances,
    balanceExceptions: rollForward.exceptions,
    stockExceptions: stockTieOut.exceptions,
    /**
     * Neither passed nor failed. Kept separate so the counts above are
     * not read as covering the whole population when they do not.
     */
    notCheckable: [
      ...doubleEntry.notCheckable,
      ...rollForward.notCheckable,
      ...stockTieOut.notCheckable,
    ],
  };

  return {
    company: companyArg ?? null,
    passed,
    period,
    currency: currency.label,
    payload,
    findings,
    exceptionCount: doubleEntry.imbalances.length + rollForward.exceptions.length,
    informationalNotes: [
      ...periodNotes,
      ...ledgerWarnings,
      ...groupWarnings,
      ...voucherWarnings,
      ...stockWarnings,
      ...accounts.warnings,
      ...adapted.warnings,
      // Only when the currency WAS established — otherwise these are
      // findings above and must not be duplicated here.
      ...(currency.comparable ? currencyWarnings : []),
    ],
  };
}

/**
 * Fold findings and notes into the response at the requested verbosity.
 *
 * Findings are NEVER dropped — only the informational notes are, and the
 * count of what went is returned so the omission is visible.
 */
function applyVerbosity(
  verbosity: 'full' | 'summary',
  findings: readonly Finding[],
  informationalNotes: readonly string[]
): Record<string, unknown> {
  const counts = summariseFindings(findings);
  const shared = {
    findings,
    findingCounts: counts,
    highestSeverity: highestSeverity(findings),
  };

  if (verbosity === 'summary') {
    return {
      ...shared,
      verbosity,
      /**
       * Said as a count rather than silently: a reader must be able to tell
       * that explanation was withheld, and how much, without guessing.
       */
      informationalNotesOmitted: informationalNotes.length,
      ...(informationalNotes.length === 0
        ? {}
        : {
            note:
              `${String(informationalNotes.length)} informational note(s) about normal behaviour ` +
              '(period defaulting, closing-balance timing, field coverage) were omitted. Nothing ' +
              'indicating a problem was suppressed. Call again with verbosity "full" to read them.',
          }),
    };
  }

  return {
    ...shared,
    verbosity,
    ...(informationalNotes.length > 0 ? { warnings: informationalNotes } : {}),
  };
}

export function registerTieOutTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_check_tie_out',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        company: companySchema,
        companies: z
          .array(z.string().min(1))
          .min(1)
          .max(10)
          .optional()
          .describe(
            'Check several companies in ONE call, each against its own books. Returns a ' +
              'per-company result plus an overall verdict that passes only if every company ' +
              'passes. Mutually exclusive with `company`. Each company is checked independently ' +
              'and no figure is ever combined across them.'
          ),
        ...dateRangeSchema,
        verbosity: verbositySchema,
      }),
    },
    async (args) =>
      runTool('tally_check_tie_out', deps, async () => {
        const verbosity = args.verbosity ?? 'full';
        const dates = { fromDate: args.fromDate, toDate: args.toDate };

        if (args.companies !== undefined) {
          if (args.company !== undefined) {
            throw new TallyError(
              'INVALID_PARAMETERS',
              'Give either `company` or `companies`, not both.',
              {
                suggestion:
                  '`companies` already covers the single-company case — drop whichever you did ' +
                  'not mean.',
              }
            );
          }

          const seen = new Set<string>();
          for (const name of args.companies) {
            const key = name.trim().toLowerCase();
            if (seen.has(key)) {
              throw new TallyError(
                'INVALID_PARAMETERS',
                `Company "${key}" is listed more than once.`,
                {
                  suggestion:
                    'Checking one company twice would report the same exceptions twice and ' +
                    'double the overall counts. Remove the repeat.',
                }
              );
            }
            seen.add(key);
          }

          // Resolved to Tally's own spelling BEFORE any work, so an unknown
          // name fails fast rather than after several slow report fetches.
          const canonical: string[] = [];
          for (const name of args.companies) {
            const resolved = await assertCompanyIsLoaded(deps, name);
            if (resolved === undefined) {
              throw new TallyError(
                'TALLY_COMPANY_NOT_LOADED',
                `Could not resolve the company "${name}".`
              );
            }
            canonical.push(resolved);
          }

          // Sequential: Tally serves one request at a time, and awaiting in
          // order keeps a failure attributable to the company that caused it.
          const results: CompanyTieOut[] = [];
          for (const company of canonical) {
            results.push(await tieOutOneCompany(deps, company, dates));
          }

          const allFindings = results.flatMap((result) => result.findings);
          const allNotes = results.flatMap((result) => result.informationalNotes);

          // Passes only if EVERY company passes. A batch that reported a
          // pass while one company was out would be worse than no gate.
          const passed = results.every((result) => result.passed);

          return whole(
            {
              passed,
              companiesChecked: canonical,
              /**
               * Per company, never combined. Totals across separate legal
               * entities are meaningless and, where currencies differ, wrong.
               */
              perCompany: results.map((result) => ({
                company: result.company,
                passed: result.passed,
                exceptions: result.exceptionCount,
                ...result.payload,
              })),
              ...applyVerbosity(verbosity, allFindings, allNotes),
            },
            results.reduce((total, result) => total + result.exceptionCount, 0)
          );
        }

        const result = await tieOutOneCompany(deps, args.company, dates);

        return whole(
          {
            ...result.payload,
            ...applyVerbosity(verbosity, result.findings, result.informationalNotes),
          },
          result.exceptionCount
        );
      })
  );
}
