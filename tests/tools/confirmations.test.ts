import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolOk,
  createToolRegistry,
  fixture,
  makeDeps,
  type ToolRegistry,
} from './harness.js';
import { registerConfirmationTools } from '../../src/tools/confirmations.js';

/**
 * The balance-confirmation selection list.
 *
 * Two things are defended here. First that the balance is the BOOK balance,
 * unadjusted and un-netted — a confirmation for an adjusted figure confirms the
 * adjustment. Second that a party with no contact details is returned rather
 * than filtered away, because a material balance owed by someone unreachable is
 * a finding before it is an inconvenience.
 */

let mock: MockTallyServer;
let port: number;

function build(): ToolRegistry {
  const registry = createToolRegistry();
  registerConfirmationTools(registry.server, makeDeps(port));
  return registry;
}

interface Row {
  party: string;
  side: string;
  magnitude: string;
  contactable: boolean;
}

const LEDGERS = `<ENVELOPE><BODY><DATA><COLLECTION>
 <LEDGER NAME="Big Debtor"><PARENT>Sundry Debtors</PARENT>
  <OPENINGBALANCE TYPE="Amount">0.00</OPENINGBALANCE>
  <CLOSINGBALANCE TYPE="Amount">-500000.00</CLOSINGBALANCE>
  <LEDGERPHONE>9876543210</LEDGERPHONE></LEDGER>
 <LEDGER NAME="Small Debtor"><PARENT>Sundry Debtors</PARENT>
  <OPENINGBALANCE TYPE="Amount">0.00</OPENINGBALANCE>
  <CLOSINGBALANCE TYPE="Amount">-1000.00</CLOSINGBALANCE>
  <LEDGERPHONE>9000000000</LEDGERPHONE></LEDGER>
 <LEDGER NAME="Unreachable Debtor"><PARENT>Sundry Debtors</PARENT>
  <OPENINGBALANCE TYPE="Amount">0.00</OPENINGBALANCE>
  <CLOSINGBALANCE TYPE="Amount">-250000.00</CLOSINGBALANCE></LEDGER>
 <LEDGER NAME="A Creditor"><PARENT>Sundry Creditors</PARENT>
  <OPENINGBALANCE TYPE="Amount">0.00</OPENINGBALANCE>
  <CLOSINGBALANCE TYPE="Amount">300000.00</CLOSINGBALANCE>
  <LEDGERCONTACT>Mr Rao</LEDGERCONTACT></LEDGER>
 <LEDGER NAME="Settled Party"><PARENT>Sundry Debtors</PARENT>
  <OPENINGBALANCE TYPE="Amount">0.00</OPENINGBALANCE>
  <CLOSINGBALANCE TYPE="Amount">0.00</CLOSINGBALANCE></LEDGER>
</COLLECTION></DATA></BODY></ENVELOPE>`;

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
  mock.onBodyContaining('<ID>Ledgers</ID>', { body: LEDGERS });
});

async function list(args: Record<string, unknown> = {}): Promise<Row[]> {
  const result = await callToolOk(build(), 'tally_get_confirmation_list', args);
  return result.items as Row[];
}

describe('selection', () => {
  it('orders by size, because coverage is built from the top down', async () => {
    const rows = await list();
    expect(rows.map((r) => r.party)).toEqual([
      'Big Debtor',
      'A Creditor',
      'Unreachable Debtor',
      'Small Debtor',
    ]);
  });

  it('takes the side from the balance, not from the group', async () => {
    // A supplier sitting in debit is an advance and belongs with receivables.
    const rows = await list();
    expect(rows.find((r) => r.party === 'Big Debtor')?.side).toBe('receivable');
    expect(rows.find((r) => r.party === 'A Creditor')?.side).toBe('payable');
  });

  it('filters by direction', async () => {
    const rows = await list({ direction: 'payable' });
    expect(rows.map((r) => r.party)).toEqual(['A Creditor']);
  });

  it('applies a minimum only when one is given, and invents no default', async () => {
    // The circularisation cut-off is an audit judgement. A default here would
    // read as a recommendation and would silently drop parties.
    const all = await list();
    expect(all).toHaveLength(4);

    const large = await list({ minimumBalance: 200000 });
    expect(large.map((r) => r.party)).toEqual(['Big Debtor', 'A Creditor', 'Unreachable Debtor']);
  });

  it('leaves settled parties out and counts them', async () => {
    const result = await callToolOk(build(), 'tally_get_confirmation_list', {});
    expect((result.items as Row[]).map((r) => r.party)).not.toContain('Settled Party');
    expect((result.excluded as { zeroBalance: number }).zeroBalance).toBe(1);
  });
});

describe('what it refuses to hide', () => {
  it('returns an uncontactable party rather than filtering it out', async () => {
    // 250,000 owed by someone with no phone, no contact and no email is a
    // finding. Dropping the row would make the problem disappear.
    const rows = await list();
    const unreachable = rows.find((r) => r.party === 'Unreachable Debtor');

    expect(unreachable).toBeDefined();
    expect(unreachable?.contactable).toBe(false);
  });

  it('warns that uncontactable parties need alternative procedures', async () => {
    const result = await callToolOk(build(), 'tally_get_confirmation_list', {});
    expect((result.warnings as string[]).join(' ')).toContain('alternative procedures');
    expect((result.warnings as string[]).join(' ')).toContain('SA 505');
  });

  it('states that the confirmation process belongs to the auditor', async () => {
    const result = await callToolOk(build(), 'tally_get_confirmation_list', {});
    const warnings = (result.warnings as string[]).join(' ');
    expect(warnings).toContain("AUDITOR'S, NOT THIS TOOL'S");
    expect(warnings).toContain('client must not handle them');
  });

  it('reports the balance unadjusted, exactly as the ledger holds it', async () => {
    const result = await callToolOk(build(), 'tally_get_confirmation_list', {});
    const row = (result.items as { balanceToConfirm: { amount: string } }[])[0];
    expect(row?.balanceToConfirm.amount).toBe('-500000');
  });
});
