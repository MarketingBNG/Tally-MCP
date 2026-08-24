import { describe, expect, it } from 'vitest';
import {
  buildGroupIndex,
  groupKey,
  isUnderAnyGroup,
  ledgersUnderGroups,
} from '../../src/model/groupTree.js';
import type { Group } from '../../src/tally/normalize.js';

/**
 * The chart these tests reason about:
 *
 *   Primary
 *    └─ Current Assets
 *        └─ Sundry Debtors
 *            ├─ Domestic
 *            │   └─ North Zone
 *            └─ Export
 *
 * "Domestic" and "North Zone" are the whole point: a receivable filed there is
 * a receivable, and the direct-parent match this module replaced returned it
 * from none of the five tools that asked for "Sundry Debtors".
 */
function group(name: string, parent: string | null): Group {
  return {
    name,
    parent,
    isRevenue: false,
    isDeemedPositive: true,
    source: { entityType: 'group', identifier: name },
  } as Group;
}

const CHART: Group[] = [
  group('Current Assets', 'Primary'),
  group('Sundry Debtors', 'Current Assets'),
  group('Domestic', 'Sundry Debtors'),
  group('North Zone', 'Domestic'),
  group('Export', 'Sundry Debtors'),
  group('Indirect Expenses', 'Primary'),
];

const DEBTORS = new Set(['sundry debtors']);

describe('groupKey', () => {
  it('trims as well as lowercases, because Tally pads its primary group name', () => {
    expect(groupKey(' Primary ')).toBe('primary');
    expect(groupKey('Sundry Debtors')).toBe('sundry debtors');
    expect(groupKey(null)).toBe('');
    expect(groupKey(undefined)).toBe('');
  });
});

describe('isUnderAnyGroup', () => {
  const index = buildGroupIndex(CHART);

  it('matches the requested group itself', () => {
    expect(isUnderAnyGroup('Sundry Debtors', DEBTORS, index)).toBe(true);
  });

  it('matches one level down — the case the direct-parent filter missed', () => {
    expect(isUnderAnyGroup('Domestic', DEBTORS, index)).toBe(true);
  });

  it('matches two levels down', () => {
    expect(isUnderAnyGroup('North Zone', DEBTORS, index)).toBe(true);
  });

  it('does not match a sibling branch', () => {
    expect(isUnderAnyGroup('Indirect Expenses', DEBTORS, index)).toBe(false);
  });

  it('does not match an ANCESTOR of the requested group', () => {
    // Current Assets is above Sundry Debtors, not under it. Walking the wrong
    // direction here would pull the entire balance sheet into a debtors list.
    expect(isUnderAnyGroup('Current Assets', DEBTORS, index)).toBe(false);
  });

  it('reports an unfiled ledger as under nothing', () => {
    expect(isUnderAnyGroup(null, DEBTORS, index)).toBe(false);
    expect(isUnderAnyGroup('', DEBTORS, index)).toBe(false);
    expect(isUnderAnyGroup('   ', DEBTORS, index)).toBe(false);
  });

  it('stops at a group that is not in the chart at all', () => {
    expect(isUnderAnyGroup('Nowhere', DEBTORS, index)).toBe(false);
  });

  it('never treats Tally\'s "Primary" sentinel as a real ancestor', () => {
    // If "Primary" were a real group name, asking for it would match every
    // ledger in the company.
    expect(isUnderAnyGroup('Current Assets', new Set(['primary']), index)).toBe(false);
    expect(isUnderAnyGroup('North Zone', new Set(['primary']), index)).toBe(false);
  });

  it('terminates on a cycle instead of hanging', () => {
    const looped = buildGroupIndex([group('A', 'B'), group('B', 'A')]);
    expect(isUnderAnyGroup('A', new Set(['unrelated']), looped)).toBe(false);
    // The cycle must not stop it from finding a target that IS on the loop.
    expect(isUnderAnyGroup('A', new Set(['b']), looped)).toBe(true);
  });
});

describe('ledgersUnderGroups', () => {
  const ledgers = [
    { name: 'Direct Debtor', parent: 'Sundry Debtors' },
    { name: 'Nested Debtor', parent: 'Domestic' },
    { name: 'Deeply Nested Debtor', parent: 'North Zone' },
    { name: 'A Supplier', parent: 'Sundry Creditors' },
    { name: 'Unfiled', parent: null },
  ];

  it('returns ledgers at and under the requested group', () => {
    const { matched, warnings } = ledgersUnderGroups(ledgers, CHART, ['Sundry Debtors']);

    expect(matched.map((l) => l.name)).toEqual([
      'Direct Debtor',
      'Nested Debtor',
      'Deeply Nested Debtor',
    ]);
    expect(warnings).toEqual([]);
  });

  it('preserves the input order', () => {
    const reversed = [...ledgers].reverse();
    const { matched } = ledgersUnderGroups(reversed, CHART, ['Sundry Debtors']);
    expect(matched.map((l) => l.name)).toEqual([
      'Deeply Nested Debtor',
      'Nested Debtor',
      'Direct Debtor',
    ]);
  });

  it('accepts several groups at once', () => {
    const { matched } = ledgersUnderGroups(ledgers, CHART, ['Export', 'Domestic']);
    expect(matched.map((l) => l.name)).toEqual(['Nested Debtor', 'Deeply Nested Debtor']);
  });

  it('names the unknown groups when nothing matched', () => {
    const { matched, warnings } = ledgersUnderGroups(ledgers, CHART, ['Sundy Debtors']);

    expect(matched).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Sundy Debtors');
    expect(warnings[0]).toContain('chart of accounts');
  });

  it('stays silent about an unknown group that changed nothing', () => {
    // "Payroll" does not exist, but debtors were still found, so the result is
    // not misleading and a warning here would be noise on every default list.
    const { matched, warnings } = ledgersUnderGroups(ledgers, CHART, ['Sundry Debtors', 'Payroll']);

    expect(matched).toHaveLength(3);
    expect(warnings).toEqual([]);
  });

  it('stays silent when a known group is simply empty', () => {
    const { matched, warnings } = ledgersUnderGroups(ledgers, CHART, ['Indirect Expenses']);

    // Nothing matched, but the group exists — that IS a fact about the books,
    // and claiming the name was wrong would be false.
    expect(matched).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('falls back to direct-parent matching when the chart could not be read', () => {
    // fetchGroupsForScoping() degrades to an empty chart on failure. The
    // fallback must be the OLD behaviour — narrower, never wrong — and it must
    // not additionally claim the requested groups do not exist.
    const { matched, warnings } = ledgersUnderGroups(ledgers, [], ['Sundry Debtors']);

    expect(matched.map((l) => l.name)).toEqual(['Direct Debtor']);
    expect(warnings).toEqual([]);
  });

  it('ignores blank group names rather than matching everything', () => {
    const { matched } = ledgersUnderGroups(ledgers, CHART, ['', '   ']);
    expect(matched).toEqual([]);
  });
});
