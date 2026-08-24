import { Decimal } from 'decimal.js';
import type { NestedRecord } from '../tally/TallyResponseParser.js';
import type { Voucher } from '../tally/normalize.js';
import { matchesText } from '../utils/text.js';

/**
 * Client-side voucher filtering, shared by every tool that searches vouchers.
 *
 * Lives in one place so every caller of `tally_get_vouchers` (including its
 * `family` mode) sees the same filter behaviour for the same filter name.
 *
 * All of this is client-side because TallyPrime cannot filter server-side. The
 * full period is fetched regardless; these predicates only decide what is
 * returned.
 */

export interface VoucherFilters {
  /** Broad match: voucher number, party, narration, entry ledger names. */
  query?: string;
  /** Any entry's ledger name. */
  ledger?: string;
  /** The party ledger on the voucher. */
  party?: string;
  narration?: string;
  /** Exact voucher type, case-insensitive. */
  voucherType?: string;
  /** Any field value, including nested structures. */
  fieldMatch?: string;
  minAmount?: number;
  maxAmount?: number;
}

/** True when the voucher satisfies every supplied filter. */
export function matchesVoucherFilters(voucher: Voucher, filters: VoucherFilters): boolean {
  if (
    filters.query !== undefined &&
    !matchesText(
      filters.query,
      voucher.voucherNumber,
      voucher.partyLedgerName,
      voucher.narration,
      ...voucher.entries.map((entry) => entry.ledgerName)
    )
  ) {
    // Per value rather than against one joined string: a needle spanning the gap
    // between two fields — the tail of a narration and the head of a ledger name
    // — used to match, which is a hit no caller could account for. `matchesText`
    // skips nulls rather than coercing them, so an absent field cannot match.
    return false;
  }

  if (
    filters.voucherType !== undefined &&
    (voucher.voucherType ?? '').toLowerCase() !== filters.voucherType.toLowerCase()
  ) {
    return false;
  }

  if (
    filters.ledger !== undefined &&
    !matchesText(
      filters.ledger,
      ...voucher.entries.map((entry) => entry.ledgerName)
    )
  ) {
    return false;
  }

  if (filters.party !== undefined && !matchesText(filters.party, voucher.partyLedgerName)) {
    return false;
  }

  if (filters.narration !== undefined && !matchesText(filters.narration, voucher.narration)) {
    return false;
  }

  if (filters.fieldMatch !== undefined && !voucherMatchesAnyField(voucher, filters.fieldMatch)) {
    return false;
  }

  if (filters.minAmount !== undefined || filters.maxAmount !== undefined) {
    const magnitude = largestEntryAmount(voucher);

    // A voucher whose amounts are all unreadable is KEPT, not silently dropped.
    // It used to score 0 and be excluded by any minAmount, so "every voucher
    // over 100,000" quietly omitted the vouchers whose size is unknown — the
    // caller got an audit population they believed was complete. Including it
    // means the caller sees a record with null amounts and can judge it.
    if (magnitude === null) return true;

    if (filters.minAmount !== undefined && magnitude.lessThan(filters.minAmount)) return false;
    if (filters.maxAmount !== undefined && magnitude.greaterThan(filters.maxAmount)) return false;
  }

  return true;
}

/**
 * Largest absolute entry amount on a voucher, used as its effective size.
 *
 * A voucher has no single "amount" — its entries net to zero by construction —
 * so the largest leg is used as a proxy. That choice is stated in every tool
 * description that exposes an amount filter, because a caller comparing
 * against a different basis would otherwise get results they cannot explain.
 *
 * Returns NULL when no entry carries a readable amount, which is different from
 * zero: a voucher of unknown size must not be treated as a voucher of size nil.
 * Decimal rather than Number because this repo does no float money arithmetic —
 * at 17 significant digits a rupee comparison silently goes wrong.
 */
export function largestEntryAmount(voucher: Voucher): Decimal | null {
  let largest: Decimal | null = null;

  for (const entry of voucher.entries) {
    if (entry.amount === null) continue;
    let value: Decimal;
    try {
      value = new Decimal(entry.amount.amount).abs();
    } catch {
      continue;
    }
    if (largest === null || value.greaterThan(largest)) largest = value;
  }

  return largest;
}

/**
 * Does any field value on the voucher, its entries, or any nested structure
 * contain this text?
 *
 * Searches values rather than named fields deliberately: which fields a
 * company populates varies, so "find 10287310249" works whether that number
 * sits in REFERENCE, UNIQUEREFERENCENUMBER, TRANSACTIONID, or a bank
 * allocation nested two levels down.
 */
export function voucherMatchesAnyField(voucher: Voucher, text: string): boolean {
  const needle = text.toLowerCase();

  const searchNested = (nested: Record<string, NestedRecord[]> | undefined): boolean => {
    if (nested === undefined) return false;
    for (const records of Object.values(nested)) {
      for (const record of records) {
        for (const value of Object.values(record.fields)) {
          if (value.toLowerCase().includes(needle)) return true;
        }
        if (searchNested(record.nested)) return true;
      }
    }
    return false;
  };

  for (const value of Object.values(voucher.fields ?? {})) {
    if (value.toLowerCase().includes(needle)) return true;
  }
  if (searchNested(voucher.nested)) return true;

  for (const entry of voucher.entries) {
    for (const value of Object.values(entry.fields ?? {})) {
      if (value.toLowerCase().includes(needle)) return true;
    }
    if (searchNested(entry.nested)) return true;
  }

  return false;
}
