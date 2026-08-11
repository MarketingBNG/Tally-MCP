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
import { registerTradingTools } from '../../src/tools/trading.js';
import { registerInventoryTools } from '../../src/tools/inventory.js';
import { registerOutstandingTools } from '../../src/tools/outstanding.js';
import { registerGstTools } from '../../src/tools/gst.js';
import { registerFlowReportTools } from '../../src/tools/flowReports.js';
import { registerSearchTools } from '../../src/tools/search.js';

/** v2 tools, against a mock serving redacted real-shape responses. */

let mock: MockTallyServer;
let port: number;

function build(overrides: Record<string, string> = {}): ToolRegistry {
  const registry = createToolRegistry();
  const deps = makeDeps(port, overrides);

  registerCompanyTools(registry.server, deps);
  registerTradingTools(registry.server, deps);
  registerInventoryTools(registry.server, deps);
  registerOutstandingTools(registry.server, deps);
  registerGstTools(registry.server, deps);
  registerFlowReportTools(registry.server, deps);
  registerSearchTools(registry.server, deps);

  return registry;
}

function serveDefaults(): void {
  mock.onBodyContaining('List of Companies', { body: fixture('company-list.xml') });
  mock.onBodyContaining('<ID>Ledgers</ID>', { body: fixture('ledger-list.xml') });
  mock.onBodyContaining('<FETCH>*</FETCH>', { body: fixture('ledger-list-allfields.xml') });
  mock.onBodyContaining('<ID>VoucherTypes</ID>', { body: fixture('voucher-types.xml') });
  mock.onBodyContaining('<ID>StockItems</ID>', { body: fixture('stock-items-empty.xml') });
  mock.onBodyContaining('Voucher Register', { body: fixture('day-book-trading.xml') });
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

const PERIOD = { fromDate: '2026-07-01', toDate: '2026-07-31' };

describe('tally_get_sales', () => {
  /**
   * The behaviour these tools exist for. "Tax Invoice" derives from Sales but
   * its name contains neither "sales" nor "invoice-as-sales" — matching on the
   * type name would silently drop it and under-report the period.
   */
  it('includes a custom voucher type resolved by its base type, not its name', async () => {
    const result = await callToolOk(build(), 'tally_get_sales', PERIOD);
    const numbers = (result.items as { voucherNumber: string }[]).map((v) => v.voucherNumber);

    expect(numbers).toEqual(['S-1', 'TI-1']);
    expect(result.voucherTypesIncluded).toEqual(
      expect.arrayContaining(['sales', 'tax invoice'])
    );
  });

  it('excludes other families', async () => {
    const result = await callToolOk(build(), 'tally_get_sales', PERIOD);
    const types = (result.items as { voucherType: string }[]).map((v) => v.voucherType);

    expect(types).not.toContain('Payment');
    expect(types).not.toContain('Purchase');
  });

  /** No summed total: which entry is "the sale" is an interpretation. */
  it('returns no computed total', async () => {
    const result = await callToolOk(build(), 'tally_get_sales', PERIOD);

    expect(result).not.toHaveProperty('total');
    expect(result).not.toHaveProperty('totalAmount');
    expect(result).not.toHaveProperty('computedTotal');
  });

  it('warns and falls back when Tally reports no matching voucher types', async () => {
    mock.reset();
    serveDefaults();
    // A type list with no Sales family at all.
    mock.onBodyContaining('<ID>VoucherTypes</ID>', {
      body: '<ENVELOPE><BODY><DATA><COLLECTION><VOUCHERTYPE NAME="Journal"><PARENT>Journal</PARENT></VOUCHERTYPE></COLLECTION></DATA></BODY></ENVELOPE>',
    });

    const result = await callToolOk(build(), 'tally_get_sales', PERIOD);

    // Falls back to the built-in name rather than matching nothing silently.
    expect(result.voucherTypesIncluded).toEqual(['sales']);
    expect((result.warnings as string[]).some((w) => /no voucher types deriving/i.test(w))).toBe(
      true
    );
  });
});

describe('tally_get_purchases', () => {
  it('returns only the purchase family', async () => {
    const result = await callToolOk(build(), 'tally_get_purchases', PERIOD);
    const numbers = (result.items as { voucherNumber: string }[]).map((v) => v.voucherNumber);

    expect(numbers).toEqual(['PU-1']);
  });
});

describe('tally_search_sales', () => {
  it('filters by party', async () => {
    const result = await callToolOk(build(), 'tally_search_sales', {
      ...PERIOD,
      party: 'Bramley',
    });

    expect((result.items as { voucherNumber: string }[]).map((v) => v.voucherNumber)).toEqual([
      'S-1',
    ]);
  });

  it('filters by amount using the largest entry', async () => {
    const result = await callToolOk(build(), 'tally_search_sales', {
      ...PERIOD,
      minAmount: 10000,
    });

    expect((result.items as { voucherNumber: string }[]).map((v) => v.voucherNumber)).toEqual([
      'S-1',
    ]);
  });

  it('matches a value inside a nested structure', async () => {
    const result = await callToolOk(build(), 'tally_search_sales', {
      ...PERIOD,
      fieldMatch: 'New Ref',
    });

    expect((result.items as { voucherNumber: string }[]).map((v) => v.voucherNumber)).toEqual([
      'S-1',
    ]);
  });
});

describe('inventory tools', () => {
  /**
   * The company used for verification has no stock. An empty list is the
   * correct answer and must not be an error, nor a phantom item read from the
   * CMPINFO counter.
   */
  it('returns an empty list for a company with no inventory', async () => {
    const result = await callToolOk(build(), 'tally_list_stock_items');

    expect(result.items).toEqual([]);
    expect(result.pagination).toMatchObject({ total: 0 });
  });

  it('does not mistake the CMPINFO counter for a stock item', async () => {
    const result = await callToolOk(build(), 'tally_list_stock_items');
    expect((result.items as unknown[]).length).toBe(0);
  });

  it('explains that the company may keep no inventory when an item is not found', async () => {
    const error = await callToolError(build(), 'tally_get_stock_item', { name: 'Widget, 12mm' });

    expect(error.code).toBe('TALLY_COMPANY_NOT_FOUND');
    expect(error.suggestion).toMatch(/no stock items at all/i);
  });

  /** Movements come from voucher inventory lines, not a stock report. */
  it('derives movements from voucher inventory lines', async () => {
    const result = await callToolOk(build(), 'tally_get_inventory_movements', PERIOD);
    const movements = result.items as {
      stockItem: string;
      voucherNumber: string;
      fields: Record<string, string>;
    }[];

    expect(movements).toHaveLength(1);
    expect(movements[0]?.stockItem).toBe('Widget, 12mm');
    expect(movements[0]?.voucherNumber).toBe('S-1');
    // Quantity exactly as Tally recorded it, unit included, never converted.
    expect(movements[0]?.fields.BILLEDQTY).toBe('100 nos');
  });

  it('filters movements to one stock item', async () => {
    const result = await callToolOk(build(), 'tally_get_inventory_movements', {
      ...PERIOD,
      stockItem: 'nonexistent',
    });

    expect(result.items).toEqual([]);
  });
});

describe('receivables and payables', () => {
  it('lists parties from the debtor group with their balances', async () => {
    const result = await callToolOk(build(), 'tally_get_receivables', PERIOD);
    const rows = result.rows ?? result.items;

    expect(result.groupsUsed).toEqual(['Sundry Debtors']);
    // Northwind Retail Limited is the only Sundry Debtor in the fixture, and
    // its balance is zero, so it is excluded by default.
    expect(rows).toEqual([]);
  });

  it('includes zero balances when asked', async () => {
    const result = await callToolOk(build(), 'tally_get_receivables', {
      ...PERIOD,
      includeZeroBalances: true,
    });

    expect((result.items as { party: string }[]).map((r) => r.party)).toEqual([
      'Northwind Retail Limited',
    ]);
  });

  it('attaches bill references from the voucher entry, not the voucher party', async () => {
    const result = await callToolOk(build(), 'tally_get_payables', {
      ...PERIOD,
      includeZeroBalances: true,
    });

    const bramley = (result.items as { party: string; bills: Record<string, string>[] }[]).find(
      (r) => r.party.startsWith('Bramley')
    );
    expect(bramley?.bills?.[0]?.BILLTYPE).toBe('New Ref');
    expect(bramley?.bills?.[0]?.NAME).toBe('S-1');
  });

  /** Ageing is never computed — the whole point of the tool's caveat. */
  it('computes no ageing or overdue buckets', async () => {
    const result = await callToolOk(build(), 'tally_get_payables', {
      ...PERIOD,
      includeZeroBalances: true,
    });

    expect(result).not.toHaveProperty('ageing');
    expect(result).not.toHaveProperty('overdue');
    for (const row of result.items as Record<string, unknown>[]) {
      expect(row).not.toHaveProperty('daysOverdue');
      expect(row).not.toHaveProperty('dueDate');
    }
  });

  it('warns when the requested groups match nothing', async () => {
    const result = await callToolOk(build(), 'tally_get_receivables', {
      ...PERIOD,
      groups: ['No Such Group'],
    });

    expect((result.warnings as string[]).some((w) => /No ledgers were found/i.test(w))).toBe(true);
  });
});

describe('GST tools', () => {
  it('reports tax ledgers and registration types in use', async () => {
    const result = await callToolOk(build(), 'tally_get_gst_summary');

    expect(result.taxGroupsUsed).toEqual(['Duties & Taxes']);
    expect(result.registrationTypesInUse).toMatchObject({ Regular: 1 });
    expect(result.partiesWithGstin).toBe(1);
  });

  it('returns transactions carrying GST fields, with the fields verbatim', async () => {
    const result = await callToolOk(build(), 'tally_get_gst_transactions', PERIOD);
    const rows = result.items as {
      voucherNumber: string;
      gstFields: Record<string, string>;
      entries?: { ledgerName: string; gstFields: Record<string, string> }[];
    }[];

    const sale = rows.find((r) => r.voucherNumber === 'S-1');
    expect(sale?.gstFields.PLACEOFSUPPLY).toBe('Karnataka');
    expect(sale?.entries?.find((e) => e.ledgerName === 'Output IGST')?.gstFields.GSTRATE).toBe(
      '18'
    );
  });

  it('excludes vouchers with no GST content at all', async () => {
    const result = await callToolOk(build(), 'tally_get_gst_transactions', PERIOD);
    const numbers = (result.items as { voucherNumber: string }[]).map((v) => v.voucherNumber);

    expect(numbers).not.toContain('P-1');
  });

  /**
   * Regression guard for a defect found against real data: Tally stamps
   * CMPGSTREGISTRATIONTYPE / CMPGSTSTATE on EVERY voucher, describing the
   * company rather than the transaction. Counting those as GST content made a
   * plain bank payment look like a GST transaction and returned all 30
   * vouchers in the period.
   */
  it('does not treat company-level GST registration as transaction GST content', async () => {
    mock.reset();
    serveDefaults();
    mock.onBodyContaining('Voucher Register', {
      body: `<ENVELOPE><BODY><DATA><TALLYMESSAGE>
        <VOUCHER VCHTYPE="Payment"><DATE>20260705</DATE><VOUCHERNUMBER>P-9</VOUCHERNUMBER>
          <VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>
          <CMPGSTREGISTRATIONTYPE>Regular</CMPGSTREGISTRATIONTYPE>
          <CMPGSTSTATE>Telangana</CMPGSTSTATE>
          <GSTREGISTRATION>Telangana Registration</GSTREGISTRATION>
          <VCHGSTCLASS>Not Applicable</VCHGSTCLASS>
          <ISGSTOVERRIDDEN>No</ISGSTOVERRIDDEN>
        </VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`,
    });

    const result = await callToolOk(build(), 'tally_get_gst_transactions', PERIOD);

    // The voucher has GST-shaped fields, but none say anything about it.
    expect(result.items).toEqual([]);
    expect(result.vouchersExamined).toBe(1);
    // Company registration is still surfaced, once, in its own place.
    expect(result.companyGstRegistration).toMatchObject({ CMPGSTREGISTRATIONTYPE: 'Regular' });
    expect((result.warnings as string[]).some((w) => /company-level GST/i.test(w))).toBe(true);
  });

  /**
   * NUMBERINGSTYLE contains the substring "GST" — numberin·GST·yle — and Tally
   * sets it on every voucher. Before it was denylisted, every voucher in a
   * period was reported as a GST transaction.
   */
  it('does not mistake NUMBERINGSTYLE for a GST field', async () => {
    mock.reset();
    serveDefaults();
    mock.onBodyContaining('Voucher Register', {
      body: `<ENVELOPE><BODY><DATA><TALLYMESSAGE>
        <VOUCHER VCHTYPE="Payment"><DATE>20260705</DATE><VOUCHERNUMBER>P-8</VOUCHERNUMBER>
          <VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>
          <NUMBERINGSTYLE>Auto Retain</NUMBERINGSTYLE>
        </VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`,
    });

    const result = await callToolOk(build(), 'tally_get_gst_transactions', PERIOD);
    expect(result.items).toEqual([]);
  });

  it('ignores GST fields whose value is an explicit negative', async () => {
    const result = await callToolOk(build(), 'tally_get_gst_transactions', PERIOD);
    const sale = (result.items as { voucherNumber: string; gstFields: Record<string, string> }[]).find(
      (r) => r.voucherNumber === 'S-1'
    );

    // PLACEOFSUPPLY is real content and survives; "Not Applicable" would not.
    expect(sale?.gstFields.PLACEOFSUPPLY).toBe('Karnataka');
    for (const value of Object.values(sale?.gstFields ?? {})) {
      expect(value.toLowerCase()).not.toBe('not applicable');
    }
  });

  /** Never calculates a liability — only reports what Tally recorded. */
  it('computes no tax liability', async () => {
    const result = await callToolOk(build(), 'tally_get_gst_transactions', PERIOD);

    expect(result).not.toHaveProperty('taxLiability');
    expect(result).not.toHaveProperty('totalTax');
    expect(result).not.toHaveProperty('netPayable');
  });
});

describe('cash flow and fund flow', () => {
  /**
   * Registered rather than omitted, per the fallback policy: an absent tool
   * leaves Claude guessing, whereas this explains itself and redirects.
   */
  it('fail with TALLY_UNSUPPORTED_OPERATION and point somewhere useful', async () => {
    for (const tool of ['tally_get_cash_flow', 'tally_get_fund_flow']) {
      const error = await callToolError(build(), tool, PERIOD);

      expect(error.code).toBe('TALLY_UNSUPPORTED_OPERATION');
      expect(error.suggestion).toMatch(/tally_get_(ledger_transactions|balance_sheet)/);
    }
  });

  it('send no request to Tally at all', async () => {
    await callToolError(build(), 'tally_get_cash_flow', PERIOD);
    expect(mock.requests).toHaveLength(0);
  });
});

describe('tally_search', () => {
  it('searches ledgers, vouchers and stock items together', async () => {
    const result = await callToolOk(build(), 'tally_search', { query: 'Bramley', ...PERIOD });

    expect((result.ledgers as { total: number }).total).toBe(1);
    expect((result.vouchers as { total: number }).total).toBe(2);
    expect((result.stockItems as { total: number }).total).toBe(0);
  });

  it('reports the voucher period searched, since masters are not date-scoped', async () => {
    const result = await callToolOk(build(), 'tally_search', { query: 'x', ...PERIOD });
    expect(result.voucherPeriodSearched).toEqual(PERIOD);
  });

  it('restricts to the requested entity types', async () => {
    const result = await callToolOk(build(), 'tally_search', {
      query: 'Bramley',
      entityTypes: ['ledger'],
      ...PERIOD,
    });

    expect(result.ledgers).toBeDefined();
    expect(result.vouchers).toBeUndefined();
    expect(result.stockItems).toBeUndefined();
  });

  /** A capped list must not be indistinguishable from a complete one. */
  it('flags truncation when a cap is hit', async () => {
    const result = await callToolOk(build(), 'tally_search', {
      query: 'a',
      entityTypes: ['ledger'],
      limit: 1,
      ...PERIOD,
    });

    const ledgers = result.ledgers as { total: number; truncated: boolean; matches: unknown[] };
    expect(ledgers.truncated).toBe(true);
    expect(ledgers.matches).toHaveLength(1);
    expect(ledgers.total).toBeGreaterThan(1);
  });

  it('finds a voucher by a value in a nested structure', async () => {
    const result = await callToolOk(build(), 'tally_search', {
      query: 'New Ref',
      entityTypes: ['voucher'],
      ...PERIOD,
    });

    expect((result.vouchers as { total: number }).total).toBe(1);
  });
});

describe('tally_get_company_features', () => {
  it('infers features from evidence and says so', async () => {
    const result = await callToolOk(build(), 'tally_get_company_features');
    const features = result.features as Record<string, { inUse: boolean; evidence: string }>;

    expect(features.inventory?.inUse).toBe(false);
    expect(features.inventory?.evidence).toMatch(/0 stock item/);

    expect(features.gst?.inUse).toBe(true);
    expect(features.billWiseTracking?.inUse).toBe(true);

    /**
     * The evidence must name all three GST signals. Checking only party
     * GSTINs reported gst:false on a real company holding 15 GST tax ledgers.
     */
    expect(features.gst?.evidence).toMatch(/GSTIN/);
    expect(features.gst?.evidence).toMatch(/registration type/);
    expect(features.gst?.evidence).toMatch(/tax ledgers/);

    // The caveat is load-bearing: these are data observations, not F11 settings.
    expect(result.caveat).toMatch(/not the F11 configuration/i);
  });
});
