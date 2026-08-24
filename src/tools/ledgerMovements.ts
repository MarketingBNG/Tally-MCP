import { Decimal } from 'decimal.js';
import type { Voucher } from '../tally/normalize.js';
import { DEFAULT_CURRENCY, type Money } from '../utils/numbers.js';

/**
 * Turning a voucher register into movements on one ledger.
 *
 * Shared by `tally_get_ledger_transactions` and `tally_get_party_statement`:
 * both filter the same fetched register down to one ledger's entries and
 * accumulate a running balance the same way, and that arithmetic must not
 * drift between the two call sites.
 */

export interface LedgerMovement {
  date: string | null;
  voucherNumber: string | null;
  voucherType: string | null;
  /** Party on the voucher, where Tally recorded one. */
  partyLedgerName: string | null;
  narration: string | null;
  /** The other ledgers on this voucher — what the entry was against. */
  contraLedgers: string[];
  amount: Money | null;
  side: 'debit' | 'credit';
  /**
   * Balance after this entry, computed by this server rather than reported by
   * Tally. Null when an amount could not be read, since continuing the
   * running total past an unreadable figure would make every later balance
   * wrong without saying so.
   */
  runningBalance: Money | null;
}

/**
 * Turn vouchers into movements on one ledger, carrying a running balance.
 *
 * Sorted by date before accumulating: the register is returned in Tally's own
 * order, and a running balance that follows an unsorted sequence is arithmetic
 * nonsense even though every individual figure is right.
 */
/**
 * The date order `buildMovements` needs, done once for a whole population.
 *
 * Exported so a caller looping over many ledgers can sort once and pass
 * `alreadySortedByDate`, rather than each call re-sorting the same list. Same
 * comparator, so the two paths cannot drift apart.
 */
export function sortVouchersByDate(vouchers: readonly Voucher[]): Voucher[] {
  return [...vouchers].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
}

export function buildMovements(
  vouchers: readonly Voucher[],
  ledgerName: string,
  openingBalance: Money | null,
  warnings: string[],
  /**
   * Set when the caller has already sorted this population by date.
   *
   * The sort does not depend on `ledgerName`, so a caller running this once per
   * ledger was copying and re-sorting the identical voucher list every time —
   * `tally_get_party_statement` does exactly that, ten times by default and more
   * on request, at O(V log V) and a full array copy each. It stays the default
   * because getting it wrong is silent: an unsorted population yields running
   * balances that are arithmetic nonsense while every individual figure looks
   * right, so the caller has to say so deliberately.
   */
  alreadySortedByDate = false
): LedgerMovement[] {
  const target = ledgerName.toLowerCase();
  const movements: LedgerMovement[] = [];

  const sorted = alreadySortedByDate
    ? vouchers
    : [...vouchers].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));

  let running: Decimal | null = new Decimal(openingBalance?.amount ?? 0);
  const currency = openingBalance?.currency ?? DEFAULT_CURRENCY;

  if (openingBalance === null) {
    // No opening balance means the running total has no anchor. Starting from
    // zero would silently present a relative total as an absolute balance.
    running = null;
    warnings.push(
      `TallyPrime reported no opening balance for "${ledgerName}", so running balances cannot be computed and are reported as null. The movements themselves are unaffected.`
    );
  }

  for (const voucher of sorted) {
    for (const entry of voucher.entries) {
      if (entry.ledgerName.toLowerCase() !== target) continue;

      if (entry.amount === null) {
        // One unreadable amount invalidates every balance after it.
        running = null;
        warnings.push(
          `An entry on voucher ${voucher.voucherNumber ?? '(no number)'} had an unreadable amount, so running balances from that point on are reported as null.`
        );
      } else if (running !== null) {
        running = running.plus(entry.amount.amount);
      }

      movements.push({
        date: voucher.date,
        voucherNumber: voucher.voucherNumber,
        voucherType: voucher.voucherType,
        partyLedgerName: voucher.partyLedgerName,
        narration: voucher.narration,
        contraLedgers: voucher.entries
          .filter((other) => other.ledgerName.toLowerCase() !== target)
          .map((other) => other.ledgerName),
        amount: entry.amount,
        side: entry.side,
        runningBalance: running === null ? null : { amount: running.toFixed(), currency },
      });
    }
  }

  return movements;
}
