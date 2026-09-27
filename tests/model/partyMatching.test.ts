import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MATCH_RULES,
  familyResolver,
  matchParties,
  type VoucherFamily,
} from '../../src/model/partyMatching.js';
import type { Voucher } from '../../src/tally/normalize.js';

/** A voucher with one party line and one balancing line. */
function voucher(
  type: string,
  date: string,
  number: string,
  party: string | null,
  amount: number
): Voucher {
  const entries = [
    ...(party === null
      ? []
      : [
          {
            ledgerName: party,
            amount: { amount: (-amount).toFixed(2), currency: 'INR' },
            side: 'debit' as const,
          },
        ]),
    {
      ledgerName: type === 'Sales' || type === 'Purchase' ? `${type} Account` : 'HDFC Bank',
      amount: { amount: amount.toFixed(2), currency: 'INR' },
      side: 'credit' as const,
    },
  ];
  return {
    guid: `${type}-${number}`,
    date,
    voucherType: type,
    voucherNumber: number,
    partyLedgerName: party,
    narration: null,
    isCancelled: false,
    isOptional: false,
    isOrderVoucher: false,
    isInventoryVoucher: false,
    lastWrittenAt: null,
    entries,
  } as unknown as Voucher;
}

const familyOf = (type: string | null): VoucherFamily => {
  const known: Record<string, VoucherFamily> = {
    Sales: 'sales',
    Purchase: 'purchase',
    Receipt: 'receipt',
    Payment: 'payment',
  };
  return known[type ?? ''] ?? 'other';
};

function run(vouchers: Voucher[], rules = DEFAULT_MATCH_RULES) {
  return matchParties({
    vouchers,
    debtors: new Set(['acme', 'beta']),
    creditors: new Set(['supplier']),
    familyOf,
    rules,
    sides: ['debtors', 'creditors'],
  });
}

describe('matching bills to settlements', () => {
  it('matches the same party and amount inside the window', () => {
    const result = run([
      voucher('Sales', '2025-04-10', 'S1', 'Acme', 1000),
      voucher('Receipt', '2025-04-20', 'R1', 'Acme', 1000),
    ]);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.kind).toBe('exact');
    expect(result.matches[0]?.daysFromBill).toBe(10);
  });

  it('never matches across parties', () => {
    const result = run([
      voucher('Sales', '2025-04-10', 'S1', 'Acme', 1000),
      voucher('Receipt', '2025-04-11', 'R1', 'Beta', 1000),
    ]);
    expect(result.matches).toHaveLength(0);
    expect(result.unmatchedBills).toHaveLength(1);
    expect(result.unmatchedSettlements).toHaveLength(1);
  });

  it('allows an advance up to daysBefore, and nothing earlier', () => {
    const inside = run([
      voucher('Sales', '2025-04-20', 'S1', 'Acme', 1000),
      voucher('Receipt', '2025-04-10', 'R1', 'Acme', 1000),
    ]);
    expect(inside.matches[0]?.daysFromBill).toBe(-10);

    const outside = run([
      voucher('Sales', '2025-04-20', 'S1', 'Acme', 1000),
      voucher('Receipt', '2025-04-09', 'R1', 'Acme', 1000),
    ]);
    expect(outside.matches).toHaveLength(0);
  });

  it('stops at daysAfter', () => {
    const result = run([
      voucher('Sales', '2025-04-01', 'S1', 'Acme', 1000),
      voucher('Receipt', '2025-05-17', 'R1', 'Acme', 1000),
    ]);
    expect(result.matches).toHaveLength(0);
  });

  it('calls a difference up to Rs 1 exact and up to Rs 35 probable', () => {
    const result = run([
      voucher('Sales', '2025-04-01', 'S1', 'Acme', 1000),
      voucher('Receipt', '2025-04-02', 'R1', 'Acme', 1000.8),
      voucher('Sales', '2025-04-05', 'S2', 'Acme', 2000),
      voucher('Receipt', '2025-04-06', 'R2', 'Acme', 1970),
      voucher('Sales', '2025-04-08', 'S3', 'Acme', 3000),
      voucher('Receipt', '2025-04-09', 'R3', 'Acme', 2950),
    ]);
    const kinds = Object.fromEntries(result.matches.map((m) => [m.bill.voucherNumber, m.kind]));
    expect(kinds).toEqual({ S1: 'exact', S2: 'probable' });
    expect(result.unmatchedBills.map((b) => b.voucherNumber)).toEqual(['S3']);
  });

  it('tries exact for every bill before any probable match', () => {
    // A probable-first greedy would give R1 to S1 (Rs 20 off) and leave S2,
    // which R1 matches exactly, unmatched.
    const result = run([
      voucher('Sales', '2025-04-01', 'S1', 'Acme', 1020),
      voucher('Sales', '2025-04-02', 'S2', 'Acme', 1000),
      voucher('Receipt', '2025-04-03', 'R1', 'Acme', 1000),
    ]);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.bill.voucherNumber).toBe('S2');
    expect(result.matches[0]?.kind).toBe('exact');
  });

  it('uses each receipt once', () => {
    const result = run([
      voucher('Sales', '2025-04-01', 'S1', 'Acme', 1000),
      voucher('Sales', '2025-04-02', 'S2', 'Acme', 1000),
      voucher('Receipt', '2025-04-03', 'R1', 'Acme', 1000),
    ]);
    expect(result.matches).toHaveLength(1);
    expect(result.unmatchedBills).toHaveLength(1);
  });

  it('matches purchases against payments for creditors', () => {
    const result = run([
      voucher('Purchase', '2025-04-01', 'P1', 'Supplier', 500),
      voucher('Payment', '2025-04-15', 'PY1', 'Supplier', 500),
    ]);
    expect(result.matches[0]?.bill.side).toBe('creditors');
  });

  it('lists bills with no party ledger instead of dropping them', () => {
    const result = run([voucher('Purchase', '2025-04-01', 'P1', null, 700)]);
    expect(result.billsWithoutParty).toHaveLength(1);
    expect(result.billsWithoutParty[0]?.paise).toBe(70000);
  });

  it('ignores cancelled vouchers', () => {
    const cancelled = { ...voucher('Sales', '2025-04-01', 'S1', 'Acme', 1000), isCancelled: true };
    expect(run([cancelled]).unmatchedBills).toHaveLength(0);
  });

  it('accounts for every bill and settlement in the party totals', () => {
    const result = run([
      voucher('Sales', '2025-04-01', 'S1', 'Acme', 1000),
      voucher('Sales', '2025-04-02', 'S2', 'Acme', 400),
      voucher('Receipt', '2025-04-03', 'R1', 'Acme', 1000),
      voucher('Receipt', '2025-04-04', 'R2', 'Acme', 99),
    ]);
    const acme = result.parties.find((p) => p.party === 'Acme');
    expect(acme).toMatchObject({
      bills: 2,
      billedPaise: 140000,
      settlements: 2,
      settledPaise: 109900,
      exactMatches: 1,
      unmatchedBills: 1,
      unmatchedBillsPaise: 40000,
      unmatchedSettlements: 1,
      unmatchedSettlementsPaise: 9900,
    });
  });
});

describe('voucher type families, for any company', () => {
  it('follows custom types down to the built-in one', () => {
    const familyOf = familyResolver([
      { name: 'Sales', parent: 'Sales' },
      { name: 'GST Sales', parent: 'Sales' },
      { name: 'Online Sales', parent: 'GST Sales' },
      { name: 'Bank Payment', parent: 'Payment' },
      { name: 'Journal', parent: 'Journal' },
    ]);
    expect(familyOf('Online Sales')).toBe('sales');
    expect(familyOf('bank payment')).toBe('payment');
    expect(familyOf('Journal')).toBe('other');
    expect(familyOf('Receipt')).toBe('receipt');
  });

  it('does not hang on a cycle', () => {
    const familyOf = familyResolver([
      { name: 'A', parent: 'B' },
      { name: 'B', parent: 'A' },
    ]);
    expect(familyOf('A')).toBe('other');
  });
});

describe('one payment against several bills', () => {
  it('matches a payment to the run of oldest bills it adds up to', () => {
    const result = run([
      voucher('Purchase', '2025-04-01', 'P1', 'Supplier', 1000),
      voucher('Purchase', '2025-04-05', 'P2', 'Supplier', 2500),
      voucher('Purchase', '2025-04-09', 'P3', 'Supplier', 700),
      voucher('Payment', '2025-04-20', 'PY1', 'Supplier', 3500),
    ]);
    expect(result.groupMatches).toHaveLength(1);
    expect(result.groupMatches[0]?.kind).toBe('grouped_exact');
    expect(result.groupMatches[0]?.bills.map((bill) => bill.voucherNumber)).toEqual(['P1', 'P2']);
    expect(result.unmatchedBills.map((bill) => bill.voucherNumber)).toEqual(['P3']);
    expect(result.unmatchedSettlements).toHaveLength(0);
  });

  it('tries single-bill matches before grouping', () => {
    // PY1 equals P2 alone; it must not be spent on P1+P2's neighbour run.
    const result = run([
      voucher('Purchase', '2025-04-01', 'P1', 'Supplier', 1000),
      voucher('Purchase', '2025-04-02', 'P2', 'Supplier', 2000),
      voucher('Payment', '2025-04-10', 'PY1', 'Supplier', 2000),
    ]);
    expect(result.matches).toHaveLength(1);
    expect(result.groupMatches).toHaveLength(0);
  });

  it('calls a group within the probable tolerance probable', () => {
    const result = run([
      voucher('Sales', '2025-04-01', 'S1', 'Acme', 1000),
      voucher('Sales', '2025-04-02', 'S2', 'Acme', 1000),
      voucher('Receipt', '2025-04-15', 'R1', 'Acme', 1980),
    ]);
    expect(result.groupMatches[0]?.kind).toBe('grouped_probable');
    expect(result.groupMatches[0]?.differencePaise).toBe(-2000);
  });

  it('keeps every bill of a group inside the date window', () => {
    // P1 is 60 days before the payment, beyond the 45-day window.
    const result = run([
      voucher('Purchase', '2025-02-01', 'P1', 'Supplier', 1000),
      voucher('Purchase', '2025-03-20', 'P2', 'Supplier', 1000),
      voucher('Payment', '2025-04-02', 'PY1', 'Supplier', 2000),
    ]);
    expect(result.groupMatches).toHaveLength(0);
  });

  it('never groups across parties', () => {
    const result = run([
      voucher('Sales', '2025-04-01', 'S1', 'Acme', 1000),
      voucher('Sales', '2025-04-02', 'S2', 'Beta', 1000),
      voucher('Receipt', '2025-04-10', 'R1', 'Acme', 2000),
    ]);
    expect(result.groupMatches).toHaveLength(0);
  });

  it('counts grouped bills in the party totals', () => {
    const result = run([
      voucher('Purchase', '2025-04-01', 'P1', 'Supplier', 1000),
      voucher('Purchase', '2025-04-05', 'P2', 'Supplier', 2500),
      voucher('Payment', '2025-04-20', 'PY1', 'Supplier', 3500),
    ]);
    expect(result.parties.find((p) => p.party === 'Supplier')).toMatchObject({
      groupedSettlements: 1,
      groupedBills: 2,
      unmatchedBills: 0,
      unmatchedSettlements: 0,
    });
  });
});
