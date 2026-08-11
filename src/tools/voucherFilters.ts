import type { NestedRecord } from '../tally/TallyResponseParser.js';
import type { Voucher } from '../tally/normalize.js';

/**
 * Client-side voucher filtering, shared by every tool that searches vouchers.
 *
 * Lives in one place so `tally_search_vouchers`, `tally_search_sales` and
 * `tally_search_purchases` cannot drift into behaving differently for the same
 * filter name — which would be invisible to a caller and produce quietly
 * inconsistent results between tools.
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
  if (filters.query !== undefined) {
    const haystack = [
      voucher.voucherNumber,
      voucher.partyLedgerName,
      voucher.narration,
      ...voucher.entries.map((entry) => entry.ledgerName),
    ]
      .filter((value): value is string => value !== null)
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(filters.query.toLowerCase())) return false;
  }

  if (
    filters.voucherType !== undefined &&
    (voucher.voucherType ?? '').toLowerCase() !== filters.voucherType.toLowerCase()
  ) {
    return false;
  }

  if (
    filters.ledger !== undefined &&
    !voucher.entries.some((entry) =>
      entry.ledgerName.toLowerCase().includes(filters.ledger!.toLowerCase())
    )
  ) {
    return false;
  }

  if (
    filters.party !== undefined &&
    !(voucher.partyLedgerName ?? '').toLowerCase().includes(filters.party.toLowerCase())
  ) {
    return false;
  }

  if (
    filters.narration !== undefined &&
    !(voucher.narration ?? '').toLowerCase().includes(filters.narration.toLowerCase())
  ) {
    return false;
  }

  if (filters.fieldMatch !== undefined && !voucherMatchesAnyField(voucher, filters.fieldMatch)) {
    return false;
  }

  if (filters.minAmount !== undefined || filters.maxAmount !== undefined) {
    const magnitude = largestEntryAmount(voucher);
    if (filters.minAmount !== undefined && magnitude < filters.minAmount) return false;
    if (filters.maxAmount !== undefined && magnitude > filters.maxAmount) return false;
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
 */
export function largestEntryAmount(voucher: Voucher): number {
  let largest = 0;
  for (const entry of voucher.entries) {
    if (entry.amount === null) continue;
    const value = Math.abs(Number(entry.amount.amount));
    if (Number.isFinite(value) && value > largest) largest = value;
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
