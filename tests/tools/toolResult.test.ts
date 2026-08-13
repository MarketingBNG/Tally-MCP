import { describe, it, expect } from 'vitest';
import { findByName } from '../../src/tools/toolResult.js';

/**
 * `fetchCollection` is exercised end-to-end through every master tool in
 * tools.test.ts and v2.test.ts against the mock Tally, which is the honest
 * test of it — it exists to send a real request and merge real parser repairs.
 * What is unit-tested here is the name lookup, whose fallback behaviour is
 * easy to get subtly wrong and hard to see in an integration test.
 */

interface Record {
  name: string;
}

const records: Record[] = [{ name: 'Bank Accounts' }, { name: 'BANK ACCOUNTS' }];

describe('findByName', () => {
  const nameOf = (record: Record): string => record.name;

  it('finds an exact match', () => {
    expect(findByName(records, 'BANK ACCOUNTS', nameOf)).toBe(records[1]);
  });

  it('falls back to a case-insensitive match', () => {
    // TallyPrime preserves whatever capitalisation the user typed, so
    // requiring an exact match would report a real ledger as missing.
    expect(findByName([{ name: 'Sundry Debtors' }], 'sundry debtors', nameOf)?.name).toBe(
      'Sundry Debtors'
    );
  });

  it('prefers the exact match over a case-insensitive one', () => {
    // Both records match case-insensitively; the exact one must win, otherwise
    // two ledgers differing only in case would be unresolvable.
    expect(findByName(records, 'Bank Accounts', nameOf)).toBe(records[0]);
  });

  it('returns undefined when nothing matches', () => {
    expect(findByName(records, 'Cash-in-Hand', nameOf)).toBeUndefined();
  });
});
