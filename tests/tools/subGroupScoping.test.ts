import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolOk,
  createToolRegistry,
  fixture,
  makeDeps,
  type ToolRegistry,
} from './harness.js';
import { registerOutstandingTools } from '../../src/tools/outstanding.js';
import { registerConfirmationTools } from '../../src/tools/confirmations.js';

/**
 * Ledgers filed in a SUB-group of the group asked for.
 *
 * Found 2026-08-22 by reading, not by a failing test — which is the point of
 * this file. Five tools scoped their ledger filter to the immediate parent:
 *
 *     groupSet.has((ledger.parent ?? '').toLowerCase())
 *
 * TallyPrime encourages nesting parties by region, segment or salesperson under
 * "Sundry Debtors". Every ledger in such a sub-group was absent from the
 * receivables list, the confirmation list, the GST and TDS summaries and the
 * fixed-asset register — not flagged, not counted as excluded, just gone from a
 * result that presented itself as complete. An auditor reading a receivables
 * total off this would have understated debtors by whatever the nested branches
 * held, with nothing on the page to suggest it.
 *
 * The chart below nests two levels deep on purpose. One level would pass
 * against a fix that only looked at the grandparent.
 */

let mock: MockTallyServer;
let port: number;

/**
 *   Current Assets
 *    └─ Sundry Debtors      <- what callers ask for
 *        └─ Domestic
 *            └─ North Zone
 *   Fixed Assets
 *    └─ Plant & Machinery
 */
const GROUPS = `<ENVELOPE><BODY><DATA><COLLECTION>
 <GROUP NAME="Current Assets"><PARENT>Primary</PARENT>
  <ISREVENUE>No</ISREVENUE><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></GROUP>
 <GROUP NAME="Sundry Debtors"><PARENT>Current Assets</PARENT>
  <ISREVENUE>No</ISREVENUE><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></GROUP>
 <GROUP NAME="Domestic"><PARENT>Sundry Debtors</PARENT>
  <ISREVENUE>No</ISREVENUE><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></GROUP>
 <GROUP NAME="North Zone"><PARENT>Domestic</PARENT>
  <ISREVENUE>No</ISREVENUE><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></GROUP>
 <GROUP NAME="Fixed Assets"><PARENT>Primary</PARENT>
  <ISREVENUE>No</ISREVENUE><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></GROUP>
 <GROUP NAME="Plant &amp; Machinery"><PARENT>Fixed Assets</PARENT>
  <ISREVENUE>No</ISREVENUE><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></GROUP>
</COLLECTION></DATA></BODY></ENVELOPE>`;

/** One debtor at each depth, plus a creditor that must never be pulled in. */
const LEDGERS = `<ENVELOPE><BODY><DATA><COLLECTION>
 <LEDGER NAME="Direct Debtor"><PARENT>Sundry Debtors</PARENT>
  <OPENINGBALANCE TYPE="Amount">0.00</OPENINGBALANCE>
  <CLOSINGBALANCE TYPE="Amount">-100000.00</CLOSINGBALANCE>
  <LEDGERPHONE>9000000001</LEDGERPHONE></LEDGER>
 <LEDGER NAME="Nested Debtor"><PARENT>Domestic</PARENT>
  <OPENINGBALANCE TYPE="Amount">0.00</OPENINGBALANCE>
  <CLOSINGBALANCE TYPE="Amount">-200000.00</CLOSINGBALANCE>
  <LEDGERPHONE>9000000002</LEDGERPHONE></LEDGER>
 <LEDGER NAME="Deeply Nested Debtor"><PARENT>North Zone</PARENT>
  <OPENINGBALANCE TYPE="Amount">0.00</OPENINGBALANCE>
  <CLOSINGBALANCE TYPE="Amount">-300000.00</CLOSINGBALANCE>
  <LEDGERPHONE>9000000003</LEDGERPHONE></LEDGER>
 <LEDGER NAME="A Creditor"><PARENT>Sundry Creditors</PARENT>
  <OPENINGBALANCE TYPE="Amount">0.00</OPENINGBALANCE>
  <CLOSINGBALANCE TYPE="Amount">400000.00</CLOSINGBALANCE></LEDGER>
</COLLECTION></DATA></BODY></ENVELOPE>`;

const NO_VOUCHERS = `<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>`;

beforeAll(async () => {
  mock = new MockTallyServer();
  port = await mock.start();
});

afterAll(async () => {
  await mock.stop();
});

beforeEach(() => {
  mock.reset();
  mock.onBodyContaining('List of Companies', { body: fixture('company-list.xml') });
  mock.onBodyContaining('<ID>Groups</ID>', { body: GROUPS });
  mock.onBodyContaining('<ID>Ledgers</ID>', { body: LEDGERS });
  mock.onBodyContaining('<ID>Voucher', { body: NO_VOUCHERS });
});

function outstanding(): ToolRegistry {
  const registry = createToolRegistry();
  registerOutstandingTools(registry.server, makeDeps(port));
  return registry;
}

function confirmations(): ToolRegistry {
  const registry = createToolRegistry();
  registerConfirmationTools(registry.server, makeDeps(port));
  return registry;
}

describe('tally_get_outstanding reaches into sub-groups', () => {
  it('includes debtors nested one and two levels below the requested group', async () => {
    const result = await callToolOk(outstanding(), 'tally_get_outstanding', {
      side: 'receivable',
      groups: ['Sundry Debtors'],
      includeZeroBalances: true,
    });

    const parties = (result.items as { party: string }[]).map((row) => row.party);

    expect(parties).toContain('Direct Debtor');
    expect(parties).toContain('Nested Debtor');
    expect(parties).toContain('Deeply Nested Debtor');
    expect(parties).not.toContain('A Creditor');
  });
});

describe('tally_get_confirmation_list reaches into sub-groups', () => {
  it('circularises nested parties, which is the whole population', async () => {
    const result = await callToolOk(confirmations(), 'tally_get_confirmation_list', {
      partyGroups: ['Sundry Debtors'],
    });

    const parties = (result.items as { party: string }[]).map((row) => row.party);

    expect(parties).toEqual(
      expect.arrayContaining(['Direct Debtor', 'Nested Debtor', 'Deeply Nested Debtor'])
    );
    expect(parties).not.toContain('A Creditor');
  });

  it('names an unknown group rather than reporting a bare empty list', async () => {
    const result = await callToolOk(confirmations(), 'tally_get_confirmation_list', {
      partyGroups: ['Sundy Debtors'],
    });

    expect(result.items).toEqual([]);
    const warnings = (result.warnings ?? []) as string[];
    expect(warnings.some((w) => w.includes('Sundy Debtors'))).toBe(true);
  });
});

describe('when the group hierarchy cannot be read', () => {
  it('falls back to the immediate parent and says so', async () => {
    // No Groups handler: the mock 501s it, which is what a Tally that rejects
    // the collection looks like from here.
    mock.reset();
    mock.onBodyContaining('List of Companies', { body: fixture('company-list.xml') });
    mock.onBodyContaining('<ID>Ledgers</ID>', { body: LEDGERS });

    const result = await callToolOk(confirmations(), 'tally_get_confirmation_list', {
      partyGroups: ['Sundry Debtors'],
    });

    const parties = (result.items as { party: string }[]).map((row) => row.party);

    // Narrower than the truth, but never wrong — and the tool still answered
    // rather than failing outright.
    expect(parties).toContain('Direct Debtor');
    expect(parties).not.toContain('Nested Debtor');

    const warnings = (result.warnings ?? []) as string[];
    expect(warnings.some((w) => w.includes('SUB-group'))).toBe(true);
  });
});
