import type { Voucher } from '../tally/normalize.js';
import { addDaysIso } from '../utils/dates.js';

/**
 * Match each party's bills against the receipts or payments that settled them.
 *
 * ## Why this runs here and not in the conversation
 *
 * A year of a real company is thousands of vouchers. Passed through the chat a
 * page at a time they do not all fit, and a match run over a population with
 * rows silently missing reports "unmatched" for bills whose receipt simply never
 * arrived — a wrong answer that looks like a finding. Matched here, on the
 * machine that holds the books, only the RESULT has to travel, and every row of
 * it is accounted for in the totals.
 *
 * ## The rules, in the order they are applied
 *
 * 1. Same party. A receipt is only ever set against a bill of the ledger it was
 *    posted to.
 * 2. A settlement dated from `daysBefore` before the bill to `daysAfter` after
 *    it. Before, because advances and card payments are often recorded ahead of
 *    the invoice.
 * 3. EXACT first: within `exactTolerance` (one unit of the company currency by default), for
 *    every bill, before anything looser is tried — so a loose pass can never
 *    take a receipt that exactly matches some other bill.
 * 4. Then PROBABLE: within `probableTolerance`. Marked as such, never as matched.
 * 5. Each settlement is used once. Among candidates the smallest difference
 *    wins, then the nearest date.
 *
 * Every match is a CANDIDATE. Same party, same amount, near date is evidence,
 * not proof — two identical invoices a week apart are indistinguishable here —
 * and the output says so rather than presenting a pairing as a fact.
 *
 * Nothing is written anywhere. This returns data; the caller decides how it is
 * shown.
 */

export type MatchSide = 'debtors' | 'creditors';
export type MatchKind = 'exact' | 'probable';
export type VoucherFamily = 'sales' | 'purchase' | 'receipt' | 'payment' | 'other';

export interface MatchRules {
  /** Largest difference, in the company currency, still called an exact match. */
  exactTolerance: number;
  /** Largest difference, in the company currency, called a probable match. */
  probableTolerance: number;
  /** How many days BEFORE the bill a settlement may be dated. */
  daysBefore: number;
  /** How many days AFTER the bill a settlement may be dated. */
  daysAfter: number;
}

export const DEFAULT_MATCH_RULES: MatchRules = {
  exactTolerance: 1,
  probableTolerance: 35,
  daysBefore: 10,
  daysAfter: 45,
};

/** One bill, or one receipt/payment line, against one party. */
export interface PartyItem {
  side: MatchSide;
  party: string;
  date: string;
  voucherType: string;
  voucherNumber: string | null;
  /** Always positive, in paise, so comparisons are exact. */
  paise: number;
  narration: string | null;
  guid: string | null;
}

export interface Match {
  kind: MatchKind;
  bill: PartyItem;
  settlement: PartyItem;
  /** Settlement minus bill, in paise. */
  differencePaise: number;
  /** Settlement date minus bill date, in days. Negative means paid in advance. */
  daysFromBill: number;
}

export interface PartyTotals {
  side: MatchSide;
  party: string;
  bills: number;
  billedPaise: number;
  settlements: number;
  settledPaise: number;
  exactMatches: number;
  probableMatches: number;
  unmatchedBills: number;
  unmatchedBillsPaise: number;
  unmatchedSettlements: number;
  unmatchedSettlementsPaise: number;
}

export interface MatchResult {
  matches: Match[];
  unmatchedBills: PartyItem[];
  unmatchedSettlements: PartyItem[];
  /** Sales or purchase vouchers carrying no party ledger at all. */
  billsWithoutParty: PartyItem[];
  parties: PartyTotals[];
}

export interface MatchInput {
  vouchers: readonly Voucher[];
  /** Lower-cased names of ledgers at or under Sundry Debtors. */
  debtors: ReadonlySet<string>;
  /** Lower-cased names of ledgers at or under Sundry Creditors. */
  creditors: ReadonlySet<string>;
  familyOf: (voucherType: string | null) => VoucherFamily;
  rules: MatchRules;
  sides: readonly MatchSide[];
}

const toPaise = (amount: string | undefined): number => Math.abs(Math.round(Number(amount) * 100));

/** Which side a voucher family bills or settles, if either. */
function roleOf(family: VoucherFamily): { side: MatchSide; role: 'bill' | 'settlement' } | null {
  switch (family) {
    case 'sales':
      return { side: 'debtors', role: 'bill' };
    case 'receipt':
      return { side: 'debtors', role: 'settlement' };
    case 'purchase':
      return { side: 'creditors', role: 'bill' };
    case 'payment':
      return { side: 'creditors', role: 'settlement' };
    default:
      return null;
  }
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

export function matchParties(input: MatchInput): MatchResult {
  const wanted = new Set(input.sides);
  const bills: PartyItem[] = [];
  const settlements: PartyItem[] = [];
  const billsWithoutParty: PartyItem[] = [];

  for (const voucher of input.vouchers) {
    // Cancelled and optional vouchers are not transactions; counting them would
    // produce bills nobody owes.
    if (voucher.isCancelled || voucher.isOptional || voucher.date === null) continue;
    const role = roleOf(input.familyOf(voucher.voucherType));
    if (role === null || !wanted.has(role.side)) continue;

    const parties = role.side === 'debtors' ? input.debtors : input.creditors;
    const base = {
      side: role.side,
      date: voucher.date,
      voucherType: voucher.voucherType ?? '',
      voucherNumber: voucher.voucherNumber,
      narration: voucher.narration,
      guid: voucher.guid,
    };

    // The party is the ENTRY's ledger, not the voucher's party field: a receipt
    // settling three parties at once is three settlements.
    const partyEntries = voucher.entries.filter((entry) =>
      parties.has(entry.ledgerName.trim().toLowerCase())
    );

    if (partyEntries.length === 0) {
      if (role.role === 'bill') {
        // Largest line as the bill value: the gross, which is what a payment settles.
        const gross = Math.max(0, ...voucher.entries.map((entry) => toPaise(entry.amount?.amount)));
        billsWithoutParty.push({ ...base, party: voucher.partyLedgerName ?? '', paise: gross });
      }
      continue;
    }

    for (const entry of partyEntries) {
      const item = { ...base, party: entry.ledgerName, paise: toPaise(entry.amount?.amount) };
      if (item.paise === 0) continue;
      (role.role === 'bill' ? bills : settlements).push(item);
    }
  }

  const byDate = (a: PartyItem, b: PartyItem): number =>
    a.date.localeCompare(b.date) || (a.voucherNumber ?? '').localeCompare(b.voucherNumber ?? '');
  bills.sort(byDate);
  settlements.sort(byDate);

  const key = (item: PartyItem): string => `${item.side}\0${item.party.trim().toLowerCase()}`;
  const pool = new Map<string, PartyItem[]>();
  for (const settlement of settlements) {
    const list = pool.get(key(settlement)) ?? [];
    list.push(settlement);
    pool.set(key(settlement), list);
  }

  const used = new Set<PartyItem>();
  const matchedBills = new Map<PartyItem, Match>();

  const pass = (kind: MatchKind, tolerancePaise: number): void => {
    for (const bill of bills) {
      if (matchedBills.has(bill)) continue;
      const earliest = addDaysIso(bill.date, -input.rules.daysBefore);
      const latest = addDaysIso(bill.date, input.rules.daysAfter);

      let best: PartyItem | null = null;
      for (const candidate of pool.get(key(bill)) ?? []) {
        if (used.has(candidate) || candidate.date < earliest || candidate.date > latest) continue;
        const difference = Math.abs(candidate.paise - bill.paise);
        if (difference > tolerancePaise) continue;
        if (best === null) {
          best = candidate;
          continue;
        }
        const bestDifference = Math.abs(best.paise - bill.paise);
        const nearer =
          Math.abs(daysBetween(bill.date, candidate.date)) <
          Math.abs(daysBetween(bill.date, best.date));
        if (difference < bestDifference || (difference === bestDifference && nearer))
          best = candidate;
      }

      if (best !== null) {
        used.add(best);
        matchedBills.set(bill, {
          kind,
          bill,
          settlement: best,
          differencePaise: best.paise - bill.paise,
          daysFromBill: daysBetween(bill.date, best.date),
        });
      }
    }
  };

  pass('exact', Math.round(input.rules.exactTolerance * 100));
  pass('probable', Math.round(input.rules.probableTolerance * 100));

  const matches = bills.flatMap((bill) => {
    const match = matchedBills.get(bill);
    return match === undefined ? [] : [match];
  });
  const unmatchedBills = bills.filter((bill) => !matchedBills.has(bill));
  const unmatchedSettlements = settlements.filter((settlement) => !used.has(settlement));

  return {
    matches,
    unmatchedBills,
    unmatchedSettlements,
    billsWithoutParty,
    parties: totalsByParty(bills, settlements, matches, unmatchedBills, unmatchedSettlements),
  };
}

function totalsByParty(
  bills: readonly PartyItem[],
  settlements: readonly PartyItem[],
  matches: readonly Match[],
  unmatchedBills: readonly PartyItem[],
  unmatchedSettlements: readonly PartyItem[]
): PartyTotals[] {
  const totals = new Map<string, PartyTotals>();
  const row = (item: PartyItem): PartyTotals => {
    const id = `${item.side}\0${item.party.trim().toLowerCase()}`;
    let found = totals.get(id);
    if (found === undefined) {
      found = {
        side: item.side,
        party: item.party,
        bills: 0,
        billedPaise: 0,
        settlements: 0,
        settledPaise: 0,
        exactMatches: 0,
        probableMatches: 0,
        unmatchedBills: 0,
        unmatchedBillsPaise: 0,
        unmatchedSettlements: 0,
        unmatchedSettlementsPaise: 0,
      };
      totals.set(id, found);
    }
    return found;
  };

  for (const bill of bills) {
    const t = row(bill);
    t.bills += 1;
    t.billedPaise += bill.paise;
  }
  for (const settlement of settlements) {
    const t = row(settlement);
    t.settlements += 1;
    t.settledPaise += settlement.paise;
  }
  for (const match of matches) {
    const t = row(match.bill);
    if (match.kind === 'exact') t.exactMatches += 1;
    else t.probableMatches += 1;
  }
  for (const bill of unmatchedBills) {
    const t = row(bill);
    t.unmatchedBills += 1;
    t.unmatchedBillsPaise += bill.paise;
  }
  for (const settlement of unmatchedSettlements) {
    const t = row(settlement);
    t.unmatchedSettlements += 1;
    t.unmatchedSettlementsPaise += settlement.paise;
  }

  return [...totals.values()].sort(
    (a, b) => a.side.localeCompare(b.side) || a.party.localeCompare(b.party)
  );
}

const KNOWN_FAMILIES: Readonly<Record<string, VoucherFamily>> = {
  sales: 'sales',
  purchase: 'purchase',
  receipt: 'receipt',
  payment: 'payment',
};

/**
 * Which family each of a company's voucher types belongs to.
 *
 * Walks the parent chain, so a type built on a custom type ("Online Sales" on
 * "GST Sales" on "Sales") still lands in its family. Every company names its
 * types differently; the four built-in roots are the only thing they share.
 * Bounded, so a cycle in the data cannot hang it.
 */
export function familyResolver(
  types: readonly { name: string; parent: string | null }[]
): (type: string | null) => VoucherFamily {
  const parentOf = new Map(
    types.map((type) => [type.name.trim().toLowerCase(), (type.parent ?? '').trim().toLowerCase()])
  );
  const byName = new Map<string, VoucherFamily>();

  for (const type of types) {
    let name = type.name.trim().toLowerCase();
    for (let depth = 0; depth < 10; depth++) {
      const family = KNOWN_FAMILIES[name];
      if (family !== undefined) {
        byName.set(type.name.trim().toLowerCase(), family);
        break;
      }
      const parent = parentOf.get(name);
      if (parent === undefined || parent === '' || parent === name) break;
      name = parent;
    }
  }

  return (type) => {
    const name = (type ?? '').trim().toLowerCase();
    return byName.get(name) ?? KNOWN_FAMILIES[name] ?? 'other';
  };
}
