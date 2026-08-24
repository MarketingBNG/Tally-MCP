import {
  Decimal,
} from 'decimal.js';


import {
  DEFAULT_CURRENCY,
  type Money,
} from '../../utils/numbers.js';

import type { Account, SignedAmount, Voucher } from '../../model/ledger.js';
import {
} from '../toolResult.js';


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
import {
  asDecimal,
  toSigned,
  TIE_OUT_TOLERANCE,
} from './shared.js';

/**
 * The three tie-out checks: stock, double entry, and balance roll-forward.
 *
 * Split out of tieOut.ts at 1,149 lines. Each is independent — it takes figures
 * and returns exceptions — and each carries its own account of what Tally does
 * that makes the check necessary. They are grouped rather than split three ways
 * because they share the exception vocabulary above them.
 */

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
