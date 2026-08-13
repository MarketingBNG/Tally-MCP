import { describe, it, expect } from 'vitest';
import { checkDoubleEntry, checkBalanceRollForward } from '../../src/tools/tieOut.js';
import { computeMateriality } from '../../src/tools/materiality.js';
import { adaptAccounts, classifyGroup, classifyVoucherFamily, toSignedAmount } from '../../src/model/fromTally.js';
import type { Account, SignedAmount, Voucher } from '../../src/model/ledger.js';
import type { Group, Ledger } from '../../src/tally/normalize.js';

/**
 * The audit computations, tested directly rather than through a tool.
 *
 * These are the figures §6 rule 1 says must never come from the model, so they
 * are the ones that most need to be right. Testing the functions rather than
 * the tool means each case is a small, readable statement of an accounting
 * fact, and the cases that matter most — the ones that must NOT be reported as
 * passes — are stated as explicitly as the ones that must.
 */

const INR = 'INR';

function debit(amount: string): SignedAmount {
  return { magnitude: { amount, currency: INR }, side: 'debit' };
}

function credit(amount: string): SignedAmount {
  return { magnitude: { amount, currency: INR }, side: 'credit' };
}

function voucher(overrides: Partial<Voucher> & { lines: Voucher['lines'] }): Voucher {
  return {
    id: 'v1',
    entityId: 'e1',
    date: '2026-07-01',
    family: 'journal',
    sourceType: 'Journal',
    number: 'J-1',
    narration: null,
    partyId: null,
    createdAt: null,
    createdBy: null,
    lastAlteredAt: null,
    lastAlteredBy: null,
    isCancelled: false,
    isDraft: false,
    documents: [],
    source: { system: 'tallyprime', entityType: 'voucher', identifier: 'v1' },
    ...overrides,
  };
}

function line(accountId: string, amount: SignedAmount | null, index = 0): Voucher['lines'][number] {
  return {
    id: `v1:${String(index)}`,
    voucherId: 'v1',
    accountId,
    amount,
    partyId: null,
    costCentreId: null,
    stockItemId: null,
    quantity: null,
    taxLines: [],
    billReferences: [],
    source: { system: 'tallyprime', entityType: 'entryLine', identifier: `v1:${String(index)}` },
  };
}

function account(name: string, opening: SignedAmount | null, closing: SignedAmount | null): Account {
  return {
    id: name,
    entityId: 'e1',
    code: null,
    name,
    parentId: null,
    path: [name],
    type: 'asset',
    normalBalance: 'debit',
    isPostable: true,
    openingBalance: opening,
    closingBalance: closing,
    source: { system: 'tallyprime', entityType: 'account', identifier: name },
  };
}

describe('double-entry check', () => {
  it('passes a voucher whose debits equal its credits', () => {
    const result = checkDoubleEntry([
      voucher({ lines: [line('Bank', debit('1000')), line('Sales', credit('1000'), 1)] }),
    ]);

    expect(result.imbalances).toEqual([]);
    expect(result.checked).toBe(1);
  });

  it('reports an unbalanced voucher and the amount it is out by', () => {
    const result = checkDoubleEntry([
      voucher({ lines: [line('Bank', debit('1000')), line('Sales', credit('900'), 1)] }),
    ]);

    expect(result.imbalances).toHaveLength(1);
    expect(result.imbalances[0]?.outBy.magnitude.amount).toBe('100');
    expect(result.imbalances[0]?.outBy.side).toBe('debit');
  });

  /**
   * The case that must not silently pass. Two readable entries here sum to
   * zero; a third is unreadable. Reporting "balanced" would be a fabricated
   * assurance about a voucher nobody can actually verify.
   */
  it('reports a voucher with an unreadable amount as not checkable, not as balanced', () => {
    const result = checkDoubleEntry([
      voucher({
        lines: [
          line('Bank', debit('1000')),
          line('Sales', credit('1000'), 1),
          line('Rounding', null, 2),
        ],
      }),
    ]);

    expect(result.imbalances).toEqual([]);
    expect(result.checked).toBe(0);
    expect(result.notCheckable).toHaveLength(1);
    expect(result.notCheckable[0]).toContain('J-1');
  });

  it('skips a cancelled voucher, which posts nothing and owes no balance', () => {
    const result = checkDoubleEntry([
      voucher({ isCancelled: true, lines: [line('Bank', debit('1000'))] }),
    ]);

    expect(result.imbalances).toEqual([]);
    expect(result.checked).toBe(0);
  });
});

describe('balance roll-forward check', () => {
  it('passes when opening plus movements equals the reported closing', () => {
    const result = checkBalanceRollForward(
      [account('Bank', debit('5000'), debit('6000'))],
      [voucher({ lines: [line('Bank', debit('1000')), line('Sales', credit('1000'), 1)] })]
    );

    expect(result.exceptions).toEqual([]);
    // One account was supplied, so one was checked. The Sales side of the
    // voucher has no account record here and is simply not part of this check.
    expect(result.checked).toBe(1);
  });

  it('reports the difference when the closing balance does not follow', () => {
    const result = checkBalanceRollForward(
      // Tally says 7000; opening 5000 plus a 1000 movement gives 6000.
      [account('Bank', debit('5000'), debit('7000'))],
      [voucher({ lines: [line('Bank', debit('1000'))] })]
    );

    expect(result.exceptions).toHaveLength(1);
    const exception = result.exceptions[0];
    expect(exception?.account).toBe('Bank');
    expect(exception?.computedClosing.magnitude.amount).toBe('6000');
    expect(exception?.difference.magnitude.amount).toBe('1000');
    expect(exception?.difference.side).toBe('credit');
    expect(exception?.movementCount).toBe(1);
  });

  /** To the paisa, per §1 outcome 3 — no tolerance band. */
  it('treats a one-paisa difference as an exception', () => {
    const result = checkBalanceRollForward(
      [account('Bank', debit('5000.00'), debit('5000.01'))],
      []
    );

    expect(result.exceptions).toHaveLength(1);
    expect(result.exceptions[0]?.difference.magnitude.amount).toBe('0.01');
  });

  it('reports a ledger with no opening balance as not checkable when it has activity', () => {
    const result = checkBalanceRollForward(
      [account('Bank', null, debit('6000'))],
      [voucher({ lines: [line('Bank', debit('1000'))] })]
    );

    expect(result.exceptions).toEqual([]);
    expect(result.checked).toBe(0);
    expect(result.notCheckable[0]).toContain('opening');
  });

  /** A dormant account with nothing in it is not a finding; it is noise. */
  it('stays silent about a dormant account with no balances and no movements', () => {
    const result = checkBalanceRollForward([account('Old Suspense', null, null)], []);

    expect(result.notCheckable).toEqual([]);
    expect(result.checked).toBe(0);
  });

  it('ignores a group heading, which carries no balance of its own', () => {
    const heading: Account = { ...account('Current Assets', null, null), isPostable: false };
    const result = checkBalanceRollForward([heading], []);

    expect(result.checked).toBe(0);
  });
});

describe('Tally adapter', () => {
  it('turns a Tally-negative balance into a debit with a positive magnitude', () => {
    const warnings: string[] = [];
    const converted = toSignedAmount({ amount: '-1500.50', currency: INR }, 'Test', warnings);

    // The magnitude is positive and the side carries the meaning — that is the
    // whole point of the convention.
    expect(converted).toEqual({
      magnitude: { amount: '1500.5', currency: INR },
      side: 'debit',
    });
  });

  it('classifies groups from Tally two flags', () => {
    const group = (isRevenue: boolean, isDeemedPositive: boolean): Group => ({
      name: 'g',
      parent: null,
      isRevenue,
      isDeemedPositive,
      source: { system: 'tallyprime', entityType: 'group', identifier: 'g' },
    });

    expect(classifyGroup(group(true, true))).toBe('expense');
    expect(classifyGroup(group(true, false))).toBe('income');
    expect(classifyGroup(group(false, true))).toBe('asset');
    expect(classifyGroup(group(false, false))).toBe('liability');
  });

  /**
   * The behaviour the descriptions promise: a company's own voucher type name
   * carries no reliable signal, so the family comes from the base type.
   */
  it('resolves a custom voucher type to its base family', () => {
    expect(classifyVoucherFamily('Sales')).toBe('sales');
    expect(classifyVoucherFamily('Credit Note')).toBe('credit_note');
    expect(classifyVoucherFamily('Tax Invoice')).toBe('other');
  });

  it('builds one tree, with groups as headings and ledgers as postable leaves', () => {
    const groups: Group[] = [
      {
        name: 'Current Assets',
        parent: null,
        isRevenue: false,
        isDeemedPositive: true,
        source: { system: 'tallyprime', entityType: 'group', identifier: 'Current Assets' },
      },
      {
        name: 'Bank Accounts',
        parent: 'Current Assets',
        isRevenue: false,
        isDeemedPositive: true,
        source: { system: 'tallyprime', entityType: 'group', identifier: 'Bank Accounts' },
      },
    ];

    const ledgers: Ledger[] = [
      {
        name: 'HDFC Current',
        parent: 'Bank Accounts',
        openingBalance: { amount: '-5000', currency: INR },
        closingBalance: { amount: '-6000', currency: INR },
        gstin: null,
        source: { system: 'tallyprime', entityType: 'ledger', identifier: 'HDFC Current' },
      },
    ];

    const { data } = adaptAccounts(groups, ledgers, { entityId: 'e1' });
    const leaf = data.find((entry) => entry.name === 'HDFC Current');

    expect(leaf?.isPostable).toBe(true);
    expect(leaf?.path).toEqual(['Current Assets', 'Bank Accounts', 'HDFC Current']);
    // Type is inherited from the primary group at the top of the chain.
    expect(leaf?.type).toBe('asset');
    expect(data.find((entry) => entry.name === 'Bank Accounts')?.isPostable).toBe(false);
  });

  /** Provenance must not leak Tally's vocabulary into the model. */
  it('translates Tally entity names into the model own', () => {
    const groups: Group[] = [
      {
        name: 'Current Assets',
        parent: null,
        isRevenue: false,
        isDeemedPositive: true,
        source: { system: 'tallyprime', entityType: 'group', identifier: 'Current Assets' },
      },
    ];

    const { data } = adaptAccounts(groups, [], { entityId: 'e1' });
    expect(data[0]?.source.entityType).toBe('account');
    expect(data[0]?.source.system).toBe('tallyprime');
  });
});

describe('materiality', () => {
  it('computes the three thresholds from a benchmark', () => {
    const result = computeMateriality({
      benchmark: 'revenue',
      amount: '12500000',
      currency: INR,
      overallPercent: '1',
      performancePercent: '75',
      clearlyTrivialPercent: '5',
    });

    expect(result.overall).toBe('125000');
    expect(result.performance).toBe('93750');
    expect(result.clearlyTrivial).toBe('6250');
  });

  /** Rounding down, so a threshold never excuses more error than its basis. */
  it('rounds down rather than to nearest', () => {
    const result = computeMateriality({
      benchmark: 'revenue',
      amount: '999999',
      currency: INR,
      overallPercent: '1',
      performancePercent: '75',
      clearlyTrivialPercent: '5',
    });

    expect(result.overall).toBe('9999');
  });

  it('uses the absolute value, so a loss is a valid basis', () => {
    const result = computeMateriality({
      benchmark: 'profit_before_tax',
      amount: '-2000000',
      currency: INR,
      overallPercent: '5',
      performancePercent: '75',
      clearlyTrivialPercent: '5',
    });

    expect(result.overall).toBe('100000');
  });

  it('records the basis and the workings alongside the figures', () => {
    const result = computeMateriality({
      benchmark: 'profit_before_tax',
      amount: '10000000',
      currency: INR,
      overallPercent: '5',
      performancePercent: '75',
      clearlyTrivialPercent: '5',
    });

    expect(result.basis.benchmark).toBe('profit_before_tax');
    expect(result.basis.customaryRange).toBe('5–10%');
    expect(result.basis.workings.join(' ')).toContain('500000');
  });
});
