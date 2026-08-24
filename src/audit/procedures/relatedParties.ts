import { Decimal } from 'decimal.js';
import type { Voucher } from '../../tally/normalize.js';

import { voucherMagnitude } from './candidates.js';

/**
 * Voucher-population audit procedures, as pure functions.
 *
 * These are the arithmetic half of `tally_test_vouchers`. They are separated
 * from the tool so they can be tested against populations built by hand —
 * including populations with a KNOWN answer, which is the only way to establish
 * that a Benford result or a seeded sample is right rather than plausible.
 * That distinction is the whole point: every one of these procedures produces
 * CANDIDATES FOR REVIEW, and a candidate presented as a finding is a false
 * statement about the data.
 *
 * Nothing here reads from TallyPrime, and nothing here uses the current date or
 * a random source that is not explicitly seeded — a workpaper has to be
 * re-derivable, and a procedure whose answer changes between two runs over the
 * same data is not evidence.
 */

/**
 * Related-party totals.
 *
 * Split out of procedures.ts at 1,114 lines. Kept apart because how a party comes
 * to be treated as related is a disclosure question rather than an exception
 * screen — see RelatedPartySource on the two routes in.
 */

/** How a party came to be treated as related. Both sources is not a conflict. */
export type RelatedPartySource = 'tally_flag' | 'supplied' | 'both';

export interface RelatedPartyTotal {
  party: string;
  source: RelatedPartySource;
  transactionCount: number;
  /** Nature of the dealing, which for Tally means the voucher type. */
  byVoucherType: { voucherType: string; count: number; total: string }[];
  /** Sum of the absolute amounts posted against this party's own ledger. */
  total: string;
  /**
   * Balance outstanding at period end, from the ledger master. Null when the
   * party's ledger could not be read — never zero, which would read as settled.
   */
  closingBalance: string | null;
  /**
   * Vouchers where this party matched but no entry line named its ledger, so
   * the voucher's largest entry stood in for the amount. Non-zero means the
   * total is an approximation and the caller has to be told.
   */
  amountsInferredFromVoucher: number;
}

/**
 * The related-party disclosure table: one row per party, not one per voucher.
 *
 * WHY THIS IS SEPARATE from the related-party screen. The screen answers "which
 * transactions involve a related party", which is the audit-testing question.
 * AS 18 / Ind AS 24 asks a different one: for each related party, the nature and
 * the aggregate volume of dealings, plus the balance outstanding at year end.
 * That is a table with one row per party, and deriving it by eye from a list of
 * two hundred vouchers is exactly the kind of manual step that gets a
 * disclosure wrong.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO:
 *
 * 1. It does not net. Amounts are absolute, so 10 lakh purchased and 10 lakh
 *    paid reports as 20 lakh transacted rather than nil. Netting would hide the
 *    volume, and volume is the disclosure.
 * 2. It does not deduplicate a voucher across two related parties. A journal
 *    between two related entities is a real dealing with each of them and
 *    appears in both rows, so the column does NOT sum to a company total. The
 *    caller is warned rather than the figure being quietly adjusted.
 */
export function summariseRelatedParties(
  vouchers: readonly Voucher[],
  /** Lower-cased party name to its display name and how it was identified. */
  related: ReadonlyMap<string, { display: string; source: RelatedPartySource }>,
  /** Lower-cased party name to closing balance, for parties whose ledger was read. */
  balances: ReadonlyMap<string, string | null>
): RelatedPartyTotal[] {
  interface Accumulator {
    display: string;
    source: RelatedPartySource;
    count: number;
    total: Decimal;
    byType: Map<string, { count: number; total: Decimal }>;
    inferred: number;
  }
  const rows = new Map<string, Accumulator>();

  for (const voucher of vouchers) {
    const party = (voucher.partyLedgerName ?? '').toLowerCase();

    // Every related name this voucher touches, whether as the party or as an
    // entry ledger. A Set because naming the same party on both is one dealing.
    const touched = new Set<string>();
    if (related.has(party)) touched.add(party);
    for (const entry of voucher.entries) {
      const ledger = entry.ledgerName.toLowerCase();
      if (related.has(ledger)) touched.add(ledger);
    }

    for (const key of touched) {
      const info = related.get(key);
      if (info === undefined) continue;

      // The amount transacted WITH this party is what was posted against its
      // own ledger — not the voucher total, which on a three-line voucher also
      // carries tax and freight that are dealings with nobody.
      let amount = new Decimal(0);
      let matched = false;
      for (const entry of voucher.entries) {
        if (entry.ledgerName.toLowerCase() !== key) continue;
        if (entry.amount === null) continue;
        amount = amount.plus(new Decimal(entry.amount.amount).abs());
        matched = true;
      }

      let inferred = 0;
      if (!matched) {
        // The party matched but no entry names its ledger. Falling back to the
        // voucher's magnitude keeps the row honest about there having been a
        // dealing; counting it separately keeps it honest about the amount.
        const magnitude = voucherMagnitude(voucher);
        if (magnitude !== null) amount = magnitude;
        inferred = 1;
      }

      const existing = rows.get(key) ?? {
        display: info.display,
        source: info.source,
        count: 0,
        total: new Decimal(0),
        byType: new Map<string, { count: number; total: Decimal }>(),
        inferred: 0,
      };
      existing.count += 1;
      existing.total = existing.total.plus(amount);
      existing.inferred += inferred;

      const type = voucher.voucherType ?? 'Unknown';
      const byType = existing.byType.get(type) ?? { count: 0, total: new Decimal(0) };
      byType.count += 1;
      byType.total = byType.total.plus(amount);
      existing.byType.set(type, byType);

      rows.set(key, existing);
    }
  }

  return [...rows.entries()]
    .map(([key, row]) => ({
      party: row.display,
      source: row.source,
      transactionCount: row.count,
      byVoucherType: [...row.byType.entries()]
        .map(([voucherType, value]) => ({
          voucherType,
          count: value.count,
          total: value.total.toFixed(),
        }))
        .sort((a, b) => (a.voucherType < b.voucherType ? -1 : 1)),
      total: row.total.toFixed(),
      closingBalance: balances.get(key) ?? null,
      amountsInferredFromVoucher: row.inferred,
    }))
    // Largest dealings first: the disclosure is read top-down and the material
    // parties belong at the top.
    .sort((a, b) => new Decimal(b.total).comparedTo(new Decimal(a.total)));
}
