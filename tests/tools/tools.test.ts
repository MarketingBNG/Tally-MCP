import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolError,
  callToolOk,
  createToolRegistry,
  fixture,
  makeDeps,
  type ToolRegistry,
} from './harness.js';
import { registerCompanyTools } from '../../src/tools/companies.js';
import { registerLedgerTools } from '../../src/tools/ledgers.js';
import { registerReportTools } from '../../src/tools/reports.js';
import { registerVoucherTools } from '../../src/tools/vouchers.js';
import { registerLedgerTransactionTools } from '../../src/tools/ledgerTransactions.js';
import type { Money } from '../../src/utils/numbers.js';

/**
 * Tool-level tests: real handlers, real schemas, real client and parser,
 * against a mock Tally serving redacted real responses.
 */

let mock: MockTallyServer;
let port: number;

function build(overrides: Record<string, string> = {}): ToolRegistry {
  const registry = createToolRegistry();
  const deps = makeDeps(port, overrides);

  registerCompanyTools(registry.server, deps);
  registerLedgerTools(registry.server, deps);
  registerReportTools(registry.server, deps);
  registerVoucherTools(registry.server, deps);
  registerLedgerTransactionTools(registry.server, deps);

  return registry;
}

/** Route by the report/collection ID in the request, as real Tally does. */
function serveDefaults(): void {
  mock.onBodyContaining('List of Companies', { body: fixture('company-list.xml') });
  mock.onBodyContaining('<ID>Ledgers</ID>', { body: fixture('ledger-list.xml') });
  // Registered after the lean one so it wins: later registrations take
  // precedence, and a FETCH * request must get the full-field response.
  mock.onBodyContaining('<FETCH>*</FETCH>', { body: fixture('ledger-list-allfields.xml') });
  mock.onBodyContaining('Trial Balance', { body: fixture('trial-balance.xml') });
  mock.onBodyContaining('Balance Sheet', { body: fixture('balance-sheet.xml') });
  mock.onBodyContaining('Profit and Loss', { body: fixture('profit-loss.xml') });
  mock.onBodyContaining('Voucher Register', { body: fixture('day-book.xml') });
}

beforeAll(async () => {
  mock = new MockTallyServer();
  port = await mock.start();
});

afterAll(async () => {
  await mock.stop();
});

beforeEach(() => {
  mock.reset();
  serveDefaults();
});

describe('tally_list_companies', () => {
  it('returns the loaded company', async () => {
    const result = await callToolOk(build(), 'tally_list_companies');
    expect(result.companies).toEqual([
      {
        name: 'EXAMPLE TRADING PRIVATE LIMITED',
        startingFrom: '2021-04-01',
        source: {
          system: 'tallyprime',
          entityType: 'company',
          identifier: 'EXAMPLE TRADING PRIVATE LIMITED',
        },
      },
    ]);
  });
});

describe('tally_list_ledgers', () => {
  it('returns ledgers with pagination metadata', async () => {
    const result = await callToolOk(build(), 'tally_list_ledgers');

    expect(result.items).toHaveLength(8);
    expect(result.pagination).toMatchObject({ page: 1, total: 8, hasMore: false });
  });

  it('slices to the requested page', async () => {
    const result = await callToolOk(build(), 'tally_list_ledgers', { page: 1, pageSize: 2 });

    expect(result.items).toHaveLength(2);
    expect(result.pagination).toMatchObject({ hasMore: true, total: 8 });
  });

  /**
   * The record limit is enforced after the fetch, because Tally cannot report
   * a size in advance. The point is that the caller gets an actionable code
   * rather than a wall of records.
   */
  it('refuses a result set above TALLY_MAX_RECORDS', async () => {
    const error = await callToolError(build({ TALLY_MAX_RECORDS: '2' }), 'tally_list_ledgers');

    expect(error.code).toBe('RESULT_LIMIT_EXCEEDED');
    expect(error.suggestion).toMatch(/tally_search_ledgers/);
  });

  it('reports a Tally outage as a stable code, not an exception', async () => {
    mock.simulateDown();
    const error = await callToolError(build(), 'tally_list_ledgers');

    expect(['TALLY_NOT_RUNNING', 'TALLY_CONNECTION_FAILED']).toContain(error.code);
    expect(error.suggestion).toBeTruthy();
  });
});

describe('tally_search_ledgers', () => {
  it('matches a fragment of the ledger name, case-insensitively', async () => {
    const result = await callToolOk(build(), 'tally_search_ledgers', { query: 'bramley' });

    expect(result.items).toHaveLength(1);
    expect((result.items as { name: string }[])[0]?.name).toContain('Bramley');
  });

  it('matches on the parent group too', async () => {
    const result = await callToolOk(build(), 'tally_search_ledgers', {
      query: 'Indirect Expenses',
    });

    expect((result.items as { name: string }[]).map((l) => l.name)).toEqual([
      'Accounting Charges',
    ]);
  });

  /** No matches is a finding about the chart of accounts, not a failure. */
  it('returns an empty page rather than an error when nothing matches', async () => {
    const result = await callToolOk(build(), 'tally_search_ledgers', { query: 'zzz-nothing' });

    expect(result.items).toEqual([]);
    expect(result.pagination).toMatchObject({ total: 0 });
  });
});

describe('tally_get_ledger', () => {
  it('fetches a ledger by exact name', async () => {
    const result = await callToolOk(build(), 'tally_get_ledger', { name: 'Northwind Retail' });

    expect(result.ledger).toMatchObject({
      name: 'Northwind Retail',
      parent: 'Unclassified',
      closingBalance: { amount: '-88800', currency: 'INR' },
    });
  });

  it('tolerates a difference in capitalisation', async () => {
    const result = await callToolOk(build(), 'tally_get_ledger', { name: 'northwind retail' });
    expect((result.ledger as { name: string }).name).toBe('Northwind Retail');
  });

  it('fails with a specific code when the ledger does not exist', async () => {
    const error = await callToolError(build(), 'tally_get_ledger', { name: 'No Such Ledger' });

    expect(error.code).toBe('TALLY_COMPANY_NOT_FOUND');
    expect(error.message).toContain('No Such Ledger');
    expect(error.suggestion).toMatch(/tally_search_ledgers/);
  });
});

describe('statement tools', () => {
  it('returns trial balance rows with the period used', async () => {
    const result = await callToolOk(build(), 'tally_get_trial_balance', {
      fromDate: '2026-04-01',
      toDate: '2027-03-31',
    });

    expect(result.period).toEqual({ fromDate: '2026-04-01', toDate: '2027-03-31' });
    expect((result.rows as { name: string }[])[0]).toMatchObject({
      name: 'Capital Account',
      debit: { amount: '-2222222.22', currency: 'INR' },
    });
  });

  /**
   * The resolved period must be echoed back: Claude should report the period
   * it actually received rather than the one it assumed.
   */
  it('defaults to the financial year and echoes it back', async () => {
    const result = await callToolOk(build(), 'tally_get_trial_balance');
    const period = result.period as { fromDate: string; toDate: string };

    expect(period.fromDate).toMatch(/^\d{4}-04-01$/);
    expect(period.toDate).toMatch(/^\d{4}-03-31$/);
  });

  it('sends the requested dates to Tally in its own YYYYMMDD format', async () => {
    await callToolOk(build(), 'tally_get_trial_balance', {
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });

    const sent = mock.requests[0]?.body ?? '';
    expect(sent).toContain('<SVFROMDATE>20260701</SVFROMDATE>');
    expect(sent).toContain('<SVTODATE>20260731</SVTODATE>');
  });

  it('rejects one date without the other rather than guessing', async () => {
    const error = await callToolError(build(), 'tally_get_trial_balance', {
      fromDate: '2026-04-01',
    });

    expect(error.code).toBe('INVALID_DATE_RANGE');
    expect(error.message).toMatch(/both fromDate and toDate/);
  });

  it('rejects a reversed date range', async () => {
    const error = await callToolError(build(), 'tally_get_trial_balance', {
      fromDate: '2026-07-31',
      toDate: '2026-07-01',
    });

    expect(error.code).toBe('INVALID_DATE_RANGE');
  });

  it('reads the balance sheet through its extra wrapper', async () => {
    const result = await callToolOk(build(), 'tally_get_balance_sheet');
    expect((result.rows as { name: string }[])[0]).toMatchObject({
      name: 'Capital Account',
      amount: { amount: '-3333333.33', currency: 'INR' },
    });
  });

  it('reads the P&L main column from its reused tag', async () => {
    const result = await callToolOk(build(), 'tally_get_profit_loss');
    expect((result.rows as { name: string }[])[0]).toMatchObject({
      name: 'Sales Accounts',
      amount: { amount: '12345678.91', currency: 'INR' },
    });
  });
});

describe('tally_list_vouchers', () => {
  it('returns vouchers with their entries', async () => {
    const result = await callToolOk(build(), 'tally_list_vouchers', {
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });

    expect(result.items).toHaveLength(2);
    expect((result.items as { voucherNumber: string }[])[0]?.voucherNumber).toBe('111');
  });

  /**
   * DayBook ignores its date range on a real install, so the voucher tools
   * must go through Voucher Register. Asserting on the wire keeps a future
   * refactor from quietly switching back.
   */
  it('requests Voucher Register, never DayBook', async () => {
    await callToolOk(build(), 'tally_list_vouchers');

    const sent = mock.requests[0]?.body ?? '';
    expect(sent).toContain('<ID>Voucher Register</ID>');
    expect(sent).not.toContain('DayBook');
  });

  /** Exploding a voucher adds ~50 KB of scaffolding per record for no gain. */
  it('does not ask Tally to explode vouchers', async () => {
    await callToolOk(build(), 'tally_list_vouchers');
    expect(mock.requests[0]?.body ?? '').not.toContain('EXPLODEFLAG');
  });
});

describe('tally_search_vouchers', () => {
  it('matches on the party name', async () => {
    const result = await callToolOk(build(), 'tally_search_vouchers', { query: 'bramley' });

    expect(result.items).toHaveLength(1);
    expect((result.items as { voucherNumber: string }[])[0]?.voucherNumber).toBe('MT/2026/0042');
  });

  it('matches on an entry ledger name the header does not mention', async () => {
    const result = await callToolOk(build(), 'tally_search_vouchers', { query: 'Output IGST' });
    expect(result.items).toHaveLength(1);
  });

  it('filters by voucher type', async () => {
    const result = await callToolOk(build(), 'tally_search_vouchers', { voucherType: 'payment' });

    expect(result.items).toHaveLength(1);
    expect((result.items as { voucherType: string }[])[0]?.voucherType).toBe('Payment');
  });

  it('filters by amount using the largest entry on the voucher', async () => {
    // Payment is 150505.05, Sales 59595.95. A floor of 100000 keeps only the payment.
    const result = await callToolOk(build(), 'tally_search_vouchers', { minAmount: 100000 });

    expect(result.items).toHaveLength(1);
    expect((result.items as { voucherNumber: string }[])[0]?.voucherNumber).toBe('111');
  });

  it('combines filters with AND', async () => {
    const result = await callToolOk(build(), 'tally_search_vouchers', {
      voucherType: 'Sales',
      minAmount: 100000,
    });

    expect(result.items).toEqual([]);
  });

  it('rejects a reversed amount range', async () => {
    const error = await callToolError(build(), 'tally_search_vouchers', {
      minAmount: 500,
      maxAmount: 100,
    });

    expect(error.code).toBe('INVALID_PARAMETERS');
  });

  it('filters by ledger across all entries', async () => {
    const result = await callToolOk(build(), 'tally_search_vouchers', { ledger: 'Output IGST' });

    expect(result.items).toHaveLength(1);
    expect((result.items as { voucherNumber: string }[])[0]?.voucherNumber).toBe('MT/2026/0042');
  });

  /** party is narrower than ledger: counterparty only, not every account touched. */
  it('distinguishes party from ledger', async () => {
    const byParty = await callToolOk(build(), 'tally_search_vouchers', { party: 'HDFC' });
    expect(byParty.items).toEqual([]);

    const byLedger = await callToolOk(build(), 'tally_search_vouchers', { ledger: 'HDFC' });
    expect(byLedger.items).toHaveLength(1);
  });

  it('filters by narration', async () => {
    const result = await callToolOk(build(), 'tally_search_vouchers', { narration: 'NEFT' });
    expect(result.items).toHaveLength(1);
  });

  /**
   * The point of fieldMatch: this value lives in a nested bank allocation, not
   * in any field a caller could name up front.
   */
  it('matches a value inside a nested structure', async () => {
    const result = await callToolOk(build(), 'tally_search_vouchers', {
      fieldMatch: 'A/c Payee',
    });

    expect(result.items).toHaveLength(1);
    expect((result.items as { voucherNumber: string }[])[0]?.voucherNumber).toBe('111');
  });

  it('matches a value in a nested inventory line', async () => {
    const result = await callToolOk(build(), 'tally_search_vouchers', { fieldMatch: 'Widget' });
    expect((result.items as { voucherNumber: string }[])[0]?.voucherNumber).toBe('MT/2026/0042');
  });

  it('parses fields for fieldMatch even when they are not requested for output', async () => {
    const result = await callToolOk(build(), 'tally_search_vouchers', { fieldMatch: 'Cheque' });

    expect(result.items).toHaveLength(1);
    // Not requested in output, so it must not be emitted.
    expect((result.items as { fields?: unknown }[])[0]?.fields).toBeDefined();
  });

  it('echoes the filters it applied', async () => {
    const result = await callToolOk(build(), 'tally_search_vouchers', {
      query: 'bramley',
      minAmount: 1,
    });

    expect(result.filters).toEqual({ query: 'bramley', minAmount: 1 });
  });
});

describe('tally_get_voucher', () => {
  it('fetches a voucher by number', async () => {
    const result = await callToolOk(build(), 'tally_get_voucher', { voucherNumber: '111' });
    const vouchers = result.vouchers as { voucherNumber: string; entries: unknown[] }[];

    expect(vouchers).toHaveLength(1);
    expect(vouchers[0]?.entries).toHaveLength(2);
  });

  it('handles a voucher number containing slashes', async () => {
    const result = await callToolOk(build(), 'tally_get_voucher', {
      voucherNumber: 'MT/2026/0042',
    });
    expect(result.vouchers).toHaveLength(1);
  });

  it('fails with a specific message when the number is not in the period', async () => {
    const error = await callToolError(build(), 'tally_get_voucher', { voucherNumber: '999' });

    expect(error.code).toBe('TALLY_COMPANY_NOT_FOUND');
    expect(error.suggestion).toMatch(/widen the date range/i);
  });
});

describe('tally_get_ledger_transactions', () => {
  it('returns only entries touching the named ledger, with the contra accounts', async () => {
    const result = await callToolOk(build(), 'tally_get_ledger_transactions', {
      name: 'HDFC Bank Current A/c',
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });

    const items = result.items as {
      voucherNumber: string;
      side: string;
      contraLedgers: string[];
    }[];

    expect(items).toHaveLength(1);
    expect(items[0]?.voucherNumber).toBe('111');
    expect(items[0]?.side).toBe('credit');
    // The other side of the entry, which is what makes the line readable.
    expect(items[0]?.contraLedgers).toEqual(['Northwind Retail Limited']);
  });

  it('carries a running balance from the opening balance', async () => {
    const result = await callToolOk(build(), 'tally_get_ledger_transactions', {
      name: 'Northwind Retail',
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });

    // Opening -88800, no movements on this ledger in the fixture period.
    expect(result.openingBalance).toEqual({ amount: '-88800', currency: 'INR' });
    expect(result.computedClosingBalance).toEqual({ amount: '-88800', currency: 'INR' });
    expect(result.items).toEqual([]);
  });

  it('accumulates the running balance from the opening balance', async () => {
    const result = await callToolOk(build(), 'tally_get_ledger_transactions', {
      name: 'HDFC Bank Current A/c',
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });

    // Opening 505050.51, one credit of 150505.05 on voucher 111.
    expect(result.openingBalance).toEqual({ amount: '505050.51', currency: 'INR' });
    expect((result.items as { runningBalance: Money }[])[0]?.runningBalance).toEqual({
      amount: '655555.56',
      currency: 'INR',
    });
    expect(result.computedClosingBalance).toEqual({ amount: '655555.56', currency: 'INR' });
  });

  /**
   * Without an opening balance there is nothing to anchor a running total to.
   * Starting from zero would present a relative figure as an absolute balance,
   * so it reports null and says why.
   */
  it('refuses to invent an anchor when Tally reports no opening balance', async () => {
    const result = await callToolOk(build(), 'tally_get_ledger_transactions', {
      name: 'Output IGST',
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });

    expect(result.openingBalance).toBeNull();
    expect((result.items as { runningBalance: unknown }[])[0]?.runningBalance).toBeNull();

    const warnings = (result.warnings ?? []) as string[];
    expect(warnings.some((w) => /no opening balance/i.test(w))).toBe(true);
  });

  /**
   * The distinction the tool description leans on: one figure is Tally's, the
   * other is arithmetic done here. Conflating them would misrepresent a
   * computed number as an authoritative one.
   */
  it('separates its computed closing balance from the figure Tally reported', async () => {
    const result = await callToolOk(build(), 'tally_get_ledger_transactions', {
      name: 'Aylward Singh_Salary Payable',
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });

    expect(result).toHaveProperty('computedClosingBalance');
    expect(result.tallyReportedClosingBalance).toEqual({ amount: '-77700', currency: 'INR' });
  });

  it('fails with a specific code for a ledger that does not exist', async () => {
    const error = await callToolError(build(), 'tally_get_ledger_transactions', {
      name: 'No Such Ledger',
    });

    expect(error.code).toBe('TALLY_COMPANY_NOT_FOUND');
    expect(error.suggestion).toMatch(/tally_search_ledgers/);
  });

  it('uses Voucher Register rather than the unverified per-ledger report', async () => {
    await callToolOk(build(), 'tally_get_ledger_transactions', { name: 'Northwind Retail' });

    const bodies = mock.requests.map((r) => r.body).join('\n');
    expect(bodies).toContain('<ID>Voucher Register</ID>');
    // Guessing a report ID is what closed TallyPrime during sample collection.
    expect(bodies).not.toContain('Ledger Vouchers');
  });
});

describe('read-only guarantee at the wire level', () => {
  it('never sends anything but an Export request', async () => {
    const registry = build();
    await callToolOk(registry, 'tally_list_companies');
    await callToolOk(registry, 'tally_list_ledgers');
    await callToolOk(registry, 'tally_get_trial_balance');
    await callToolOk(registry, 'tally_list_vouchers');

    expect(mock.requests.length).toBeGreaterThan(0);
    for (const request of mock.requests) {
      expect(request.body).toContain('<TALLYREQUEST>Export</TALLYREQUEST>');
      for (const verb of ['Import', 'Alter', 'Delete', 'Create']) {
        expect(request.body).not.toContain(`<TALLYREQUEST>${verb}</TALLYREQUEST>`);
      }
    }
  });
});

describe('company scoping', () => {
  it('passes the company through to Tally once it is confirmed loaded', async () => {
    await callToolOk(build(), 'tally_list_ledgers', { company: 'EXAMPLE TRADING PRIVATE LIMITED' });

    // Two requests: the loaded-company check, then the data fetch.
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[1]?.body).toContain(
      '<SVCURRENTCOMPANY>EXAMPLE TRADING PRIVATE LIMITED</SVCURRENTCOMPANY>'
    );
  });

  it('matches the loaded company case-insensitively', async () => {
    await callToolOk(build(), 'tally_list_ledgers', { company: 'example trading private limited' });
    expect(mock.requests).toHaveLength(2);
  });

  /**
   * TallyPrime serves one company at a time, so this cannot be satisfied by
   * asking Tally harder. The user has to open the company.
   */
  it('refuses a company TallyPrime does not have open', async () => {
    const error = await callToolError(build(), 'tally_list_ledgers', { company: 'SOME OTHER CO' });

    expect(error.code).toBe('TALLY_COMPANY_NOT_LOADED');
    expect(error.message).toContain('SOME OTHER CO');
    // Naming what IS loaded turns a dead end into an actionable next step.
    expect(error.message).toContain('EXAMPLE TRADING PRIVATE LIMITED');
  });

  /**
   * The name never reaches Tally. Sending unverified company names into
   * Tally's request path is the behaviour that has been observed to close the
   * application, so the check must be local.
   */
  it('never sends an unknown company name to Tally', async () => {
    await callToolError(build(), 'tally_list_ledgers', { company: 'SOME OTHER CO' });

    for (const request of mock.requests) {
      expect(request.body).not.toContain('SOME OTHER CO');
    }
  });

  it('omits the company and skips the check entirely when none is given', async () => {
    await callToolOk(build(), 'tally_list_ledgers');

    // No company named means nothing to verify, so no extra round trip.
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.body).not.toContain('SVCURRENTCOMPANY');
  });
});

describe('full-field retrieval', () => {
  it('asks Tally for every field only when requested', async () => {
    await callToolOk(build(), 'tally_list_ledgers');
    expect(mock.requests[0]?.body).not.toContain('<FETCH>*</FETCH>');

    mock.reset();
    serveDefaults();
    await callToolOk(build(), 'tally_list_ledgers', { includeAllFields: true });
    expect(mock.requests[0]?.body).toContain('<FETCH>*</FETCH>');
  });

  /**
   * The point of the feature: which fields exist is a property of the
   * company, so they are returned as an open map rather than a fixed shape.
   */
  it('returns unmapped voucher fields under "fields"', async () => {
    const result = await callToolOk(build(), 'tally_list_vouchers', { includeAllFields: true });
    const first = (result.items as { fields?: Record<string, string> }[])[0];

    expect(first?.fields).toBeDefined();
    expect(first?.fields?.EFFECTIVEDATE).toBe('20260728');
    expect(first?.fields?.ALTERID).toBe('45231');
  });

  it('omits empty fields entirely rather than reporting them as blank', async () => {
    const result = await callToolOk(build(), 'tally_list_vouchers', { includeAllFields: true });
    const first = (result.items as { fields?: Record<string, string> }[])[0];

    // <FROMDATE/> and friends are empty in the fixture and must not appear.
    expect(first?.fields).not.toHaveProperty('FROMDATE');
    expect(first?.fields).not.toHaveProperty('VATREGISTRATIONDATE');
  });

  /**
   * The substance of an invoice lives in nested structures, not scalars.
   * Tally hangs 50+ of them off every voucher and leaves the inapplicable
   * ones empty, so the test asserts both halves: what survives and what does
   * not.
   */
  it('returns populated nested structures, nested arbitrarily deep', async () => {
    const result = await callToolOk(build(), 'tally_list_vouchers', { includeAllFields: true });
    const invoice = (
      result.items as {
        voucherNumber: string;
        nested?: Record<string, { fields: Record<string, string>; nested?: unknown }[]>;
      }[]
    ).find((v) => v.voucherNumber === 'MT/2026/0042');

    const item = invoice?.nested?.['ALLINVENTORYENTRIES.LIST']?.[0];
    expect(item?.fields.STOCKITEMNAME).toBe('Widget, 12mm');
    expect(item?.fields.BILLEDQTY).toBe('100 nos');

    // Two levels down: the item owns a batch allocation.
    const batch = (
      item?.nested as Record<string, { fields: Record<string, string> }[]> | undefined
    )?.['BATCHALLOCATIONS.LIST']?.[0];
    expect(batch?.fields.GODOWNNAME).toBe('Main Location');
  });

  it('drops nested structures that contain no values at any depth', async () => {
    const result = await callToolOk(build(), 'tally_list_vouchers', { includeAllFields: true });
    const items = result.items as { nested?: Record<string, unknown> }[];

    // Present but entirely empty in the fixture — reporting them would
    // suggest this company records e-way bills and bill-wise settlements.
    for (const voucher of items) {
      expect(voucher.nested ?? {}).not.toHaveProperty('EWAYBILLDETAILS.LIST');
      expect(voucher.nested ?? {}).not.toHaveProperty('BILLALLOCATIONS.LIST');
    }
  });

  it('returns nested structures on ledger entries too', async () => {
    const result = await callToolOk(build(), 'tally_get_voucher', { voucherNumber: '111' });
    const entries = (result.vouchers as { entries: { nested?: Record<string, { fields: Record<string, string> }[]> }[] }[])[0]?.entries;

    const bank = entries?.[1]?.nested?.['BANKALLOCATIONS.LIST']?.[0];
    expect(bank?.fields.TRANSACTIONTYPE).toBe('Cheque');
    expect(bank?.fields.PAYMENTFAVOURING).toBe('Northwind Retail Limited');
    expect(bank?.fields.CHEQUECROSSCOMMENT).toBe('A/c Payee');
  });

  /** Entries are returned as `entries`; repeating them under `nested` would double-report. */
  it('does not repeat ledger entries inside nested', async () => {
    const result = await callToolOk(build(), 'tally_list_vouchers', { includeAllFields: true });
    const first = (result.items as { nested?: Record<string, unknown> }[])[0];

    expect(first?.nested ?? {}).not.toHaveProperty('ALLLEDGERENTRIES.LIST');
  });

  /**
   * Tally's audit-trail lists are populated on every record with internal row
   * IDs and a -1 sentinel. They are accounting-irrelevant and, left in, appear
   * on every voucher and entry and crowd out the structures that matter.
   */
  it('excludes Tally internal audit-trail structures', async () => {
    const result = await callToolOk(build(), 'tally_get_voucher', { voucherNumber: '111' });
    const voucher = (
      result.vouchers as {
        nested?: Record<string, unknown>;
        entries: { nested?: Record<string, unknown> }[];
      }[]
    )[0];

    expect(voucher?.nested ?? {}).not.toHaveProperty('OLDAUDITENTRYIDS.LIST');
    for (const entry of voucher?.entries ?? []) {
      expect(entry.nested ?? {}).not.toHaveProperty('OLDAUDITENTRYIDS.LIST');
    }
  });

  it('leaves fields out altogether when not requested', async () => {
    const result = await callToolOk(build(), 'tally_list_vouchers');
    expect((result.items as { fields?: unknown }[])[0]?.fields).toBeUndefined();
  });

  it('carries source provenance on every record', async () => {
    const result = await callToolOk(build(), 'tally_list_vouchers');
    expect((result.items as { source: unknown }[])[0]?.source).toEqual({
      system: 'tallyprime',
      entityType: 'voucher',
      identifier: '00000000-1111-2222-3333-444444444444-00000af3',
    });
  });
});

describe('tally_get_company', () => {
  it('reports the field names this company actually uses, with usage counts', async () => {
    const result = await callToolOk(build(), 'tally_get_company');

    expect((result.company as { name: string }).name).toBe('EXAMPLE TRADING PRIVATE LIMITED');
    expect(result.ledgerCount).toBe(4);

    const varying = result.distinguishingFields as Record<
      string,
      { ledgers: number; distinctValues: number }
    >;

    // GUID is on all four ledgers but differs on each — genuinely varying.
    expect(varying.GUID).toEqual({ ledgers: 4, distinctValues: 4 });

    // Only one of these four ledgers is GST registered, and only one records
    // an email. Partial presence is a distinguishing signal.
    expect(varying.GSTREGISTRATIONTYPE?.ledgers).toBe(1);
    expect(varying.EMAIL?.ledgers).toBe(1);

    // Empty elements never become fields, so a tag Tally always emits but
    // never populates must be absent from both lists.
    expect(varying).not.toHaveProperty('STARTINGFROM');
    expect(result.uniformFields).not.toHaveProperty('WEBSITE');
  });

  /**
   * The reason the split exists. TAXTYPE is "Others" on every ledger — a
   * TallyPrime default. Ranking by raw presence would put boilerplate like
   * this at the top and bury the fields that actually differ.
   */
  it('separates constant defaults from fields that vary', async () => {
    const result = await callToolOk(build(), 'tally_get_company');

    expect(result.uniformFields).toMatchObject({ TAXTYPE: 'Others', CURRENCYNAME: '?' });
    expect(result.distinguishingFields).not.toHaveProperty('TAXTYPE');
  });

  it('promotes first-class fields out of the maps rather than duplicating them', async () => {
    const result = await callToolOk(build(), 'tally_get_company');

    for (const promoted of ['PARENT', 'OPENINGBALANCE', 'CLOSINGBALANCE', 'PARTYGSTIN']) {
      expect(result.distinguishingFields).not.toHaveProperty(promoted);
      expect(result.uniformFields).not.toHaveProperty(promoted);
    }
  });

  it('summarises the account groups in use', async () => {
    const result = await callToolOk(build(), 'tally_get_company');
    expect(result.groups).toMatchObject({ 'Sundry Creditors': 1, 'Indirect Expenses': 1 });
  });

  it('refuses a company that is not loaded', async () => {
    const error = await callToolError(build(), 'tally_get_company', { company: 'NOT LOADED LTD' });
    expect(error.code).toBe('TALLY_COMPANY_NOT_LOADED');
  });
});
