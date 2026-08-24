import {
  Decimal,
} from 'decimal.js';


import {
  absolute,
  sumMoney,
  type Money,
} from '../../utils/numbers.js';

import type { SignedAmount, } from '../../model/ledger.js';


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

/**
 * The amount handling every tie-out check shares.
 *
 * Split out of tieOut.ts at 1,149 lines. `asDecimal`/`toSigned` are the bridge
 * between the model's explicit debit/credit side and signed arithmetic; keeping
 * them in one place is what stops two checks disagreeing about what a credit is.
 */

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
export function asDecimal(amount: SignedAmount | null): Decimal | null {
  if (amount === null) return null;
  const magnitude = new Decimal(amount.magnitude.amount);
  return amount.side === 'debit' ? magnitude : magnitude.negated();
}

/** Back to the model's explicit-side form. */
export function toSigned(value: Decimal, currency: string): SignedAmount {
  return {
    magnitude: { amount: value.abs().toFixed(), currency },
    side: value.isNegative() ? 'credit' : 'debit',
  };
}

/** Rounding floor for the stock tie-out, in currency units. */
export const TIE_OUT_TOLERANCE = '0.01';

/**
 * Total of every imbalance, so the scale of the problem is visible at a glance.
 *
 * Signs are applied first (`asDecimal`), then summed as ordinary money, so the
 * same-currency guard in `sumMoney` covers this: a total across two currencies
 * comes back labelled `unknown` rather than wearing the first component's
 * currency. It should not arise — a tie-out runs against one company — but the
 * guard costs nothing and the alternative is a mislabelled figure in a
 * workpaper.
 */
export function sumOf(
  amounts: readonly SignedAmount[],
  fallbackCurrency: string
): { total: Money; mixedCurrencies: string[] } {
  const signed = amounts.map((amount) => ({
    amount: (asDecimal(amount) ?? new Decimal(0)).toFixed(),
    currency: amount.magnitude.currency,
  }));
  const { total, mixedCurrencies } = sumMoney(signed, fallbackCurrency);
  // Magnitude only: this reports scale, and the direction of a net imbalance
  // across unrelated vouchers is not meaningful.
  return { total: absolute(total), mixedCurrencies };
}
