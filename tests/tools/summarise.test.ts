import { describe, it, expect } from 'vitest';
import { summariseMovements } from '../../src/tools/summarise.js';
import type { Voucher } from '../../src/tally/normalize.js';

/**
 * The arithmetic is the whole value of this tool, so it is tested directly
 * rather than only through the tool envelope.
 *
 * Amounts follow Tally's own encoding throughout: a DEBIT is negative.
 */

function voucher(partial: Partial<Voucher> & { entries: Voucher['entries'] }): Voucher {
  return {
    guid: partial.guid ?? `guid-${String(Math.abs(hash(JSON.stringify(partial.entries))))}`,
    date: partial.date ?? '2025-04-11',
    voucherType: partial.voucherType ?? 'Sales',
    voucherNumber: partial.voucherNumber ?? '1',
    partyLedgerName: partial.partyLedgerName ?? 'Acme Ltd',
    narration: null,
    isCancelled: partial.isCancelled ?? false,
    isOptional: false,
    entries: partial.entries,
    source: { system: 'tallyprime', entityType: 'voucher', identifier: 'x' },
  };
}

/** Deterministic, so a guid never collides between two different entry sets. */
function hash(text: string): number {
  let out = 0;
  for (const char of text) out = (out * 31 + char.charCodeAt(0)) | 0;
  return out;
}

const money = (amount: string) => ({ amount, currency: '$' });

/** A balanced sale: party debited 100, sales credited 100. */
const SALE = voucher({
  date: '2025-04-11',
  voucherType: 'Sales',
  entries: [
    { ledgerName: 'Acme Ltd', amount: money('-100'), side: 'debit' },
    { ledgerName: 'Sales Export', amount: money('100'), side: 'credit' },
  ],
});

/** A balanced payment in a later month. */
const PAYMENT = voucher({
  date: '2025-05-02',
  voucherType: 'Payment',
  voucherNumber: '2',
  entries: [
    { ledgerName: 'City Bank', amount: money('40') , side: 'credit' },
    { ledgerName: 'Office Rent', amount: money('-40'), side: 'debit' },
  ],
});

describe('summariseMovements', () => {
  it('reports net in Tally own sign convention: credit positive, debit negative', () => {
    // The regression that matters. An earlier version negated this, so a sales
    // ledger summarised to -412,276.25 while TallyPrime's own master reported
    // +412,276.25 for the same ledger — arithmetically consistent, and the
    // opposite of what the accountant sees on screen.
    const { rows } = summariseMovements([SALE], 'ledger', () => null, []);

    const sales = rows.find((row) => row.key === 'Sales Export');
    const party = rows.find((row) => row.key === 'Acme Ltd');

    expect(sales?.net).toEqual(money('100'));
    expect(sales?.totalCredit).toEqual(money('100'));
    expect(sales?.totalDebit).toEqual(money('0'));

    expect(party?.net).toEqual(money('-100'));
    expect(party?.totalDebit).toEqual(money('100'));
  });

  it('nets to exactly zero across all groups when nothing is restricted', () => {
    // Double entry, asserted at aggregate level rather than per voucher.
    for (const groupBy of ['ledger', 'month', 'voucherType', 'party'] as const) {
      const { allNetToZero } = summariseMovements([SALE, PAYMENT], groupBy, () => null, []);
      expect(allNetToZero, groupBy).toBe(true);
    }
  });

  it('restricts ENTRIES rather than vouchers, which is what makes a one-sided total possible', () => {
    // Grouping every entry by month nets to nil in every month, because both
    // sides fall in the same month. Restricting to the sales entries is what
    // turns "sales by month" from twelve zeroes into an answer.
    const unrestricted = summariseMovements([SALE, PAYMENT], 'month', () => null, []);
    expect(unrestricted.rows.map((row) => row.net.amount)).toEqual(['0', '0']);

    const salesOnly = summariseMovements([SALE, PAYMENT], 'month', () => null, [], (name) =>
      name.toLowerCase().includes('sales')
    );

    expect(salesOnly.rows).toHaveLength(1);
    expect(salesOnly.rows[0]).toMatchObject({ key: '2025-04', net: money('100') });
  });

  it('excludes a cancelled voucher entirely', () => {
    const cancelled = voucher({
      isCancelled: true,
      voucherNumber: '99',
      entries: [
        { ledgerName: 'Acme Ltd', amount: money('-5000'), side: 'debit' },
        { ledgerName: 'Sales Export', amount: money('5000'), side: 'credit' },
      ],
    });

    const { rows } = summariseMovements([SALE, cancelled], 'ledger', () => null, []);
    expect(rows.find((row) => row.key === 'Sales Export')?.net).toEqual(money('100'));
  });

  it('counts an unreadable amount as excluded rather than as zero', () => {
    const unreadable = voucher({
      voucherNumber: '3',
      entries: [
        { ledgerName: 'Sales Export', amount: null, side: 'credit' },
        { ledgerName: 'Acme Ltd', amount: money('-7'), side: 'debit' },
      ],
    });

    const warnings: string[] = [];
    const { rows } = summariseMovements([unreadable], 'ledger', () => null, warnings);

    const sales = rows.find((row) => row.key === 'Sales Export');
    expect(sales?.entriesExcludedFromTotals).toBe(1);
    // Counted as present, but contributing nothing — not silently a zero total.
    expect(sales?.entryCount).toBe(1);
    expect(sales?.net).toEqual(money('0'));
    expect(warnings.join(' ')).toMatch(/did not report readably/);
  });

  it('groups by the account group when given a parent lookup', () => {
    const parents = new Map([
      ['sales export', 'Sales Accounts'],
      ['acme ltd', 'Sundry Debtors'],
    ]);

    const { rows } = summariseMovements(
      [SALE],
      'group',
      (name) => parents.get(name.toLowerCase()) ?? null,
      []
    );

    expect(rows.map((row) => row.key).sort()).toEqual(['Sales Accounts', 'Sundry Debtors']);
  });

  it('reports a ledger with no known group as ungrouped rather than dropping it', () => {
    const { rows } = summariseMovements([SALE], 'group', () => null, []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe('(ungrouped)');
    // Both legs landed in the one bucket, so it still balances.
    expect(rows[0]?.net).toEqual(money('0'));
  });

  it('counts distinct vouchers, not entries', () => {
    const { rows } = summariseMovements([SALE, PAYMENT], 'voucherType', () => null, []);
    const sales = rows.find((row) => row.key === 'Sales');

    expect(sales?.voucherCount).toBe(1);
    expect(sales?.entryCount).toBe(2);
  });
});
