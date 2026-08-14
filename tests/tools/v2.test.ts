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
import { registerVoucherTools } from '../../src/tools/vouchers.js';
import { registerInventoryTools } from '../../src/tools/inventory.js';
import { registerMasterTools } from '../../src/tools/masters.js';
import { registerOutstandingTools } from '../../src/tools/outstanding.js';
import { registerGstTools } from '../../src/tools/gst.js';
import { registerReportTools } from '../../src/tools/reports.js';
import { registerSearchTools } from '../../src/tools/search.js';

/**
 * The shared company fixture, but with books covering the voucher fixtures.
 *
 * Inline rather than a fixture file because it carries no real data — it exists
 * only so a DEFAULTED period can contain something, which the shared fixture
 * cannot do: its books end 2022-03-31 while its vouchers are dated July 2026.
 */
const COMPANY_WITH_CURRENT_BOOKS = [
  '<ENVELOPE><BODY><DATA><COLLECTION>',
  '<COMPANY NAME="EXAMPLE TRADING PRIVATE LIMITED">',
  '<ENDINGAT TYPE="Date">20270331</ENDINGAT>',
  '<STARTINGFROM TYPE="Date">20260401</STARTINGFROM>',
  '<NAME TYPE="String">EXAMPLE TRADING PRIVATE LIMITED</NAME>',
  '</COMPANY>',
  '</COLLECTION></DATA></BODY></ENVELOPE>',
].join('');


/** v2 tools, against a mock serving redacted real-shape responses. */

let mock: MockTallyServer;
let port: number;

function build(overrides: Record<string, string> = {}): ToolRegistry {
  const registry = createToolRegistry();
  const deps = makeDeps(port, overrides);

  registerCompanyTools(registry.server, deps);
  registerVoucherTools(registry.server, deps);
  registerInventoryTools(registry.server, deps);
  registerMasterTools(registry.server, deps);
  registerOutstandingTools(registry.server, deps);
  registerGstTools(registry.server, deps);
  registerReportTools(registry.server, deps);
  registerSearchTools(registry.server, deps);

  return registry;
}

function serveDefaults(): void {
  mock.onBodyContaining('List of Companies', { body: fixture('company-list.xml') });
  mock.onBodyContaining('<ID>Ledgers</ID>', { body: fixture('ledger-list.xml') });
  mock.onBodyContaining('<FETCH>*</FETCH>', { body: fixture('ledger-list-allfields.xml') });
  mock.onBodyContaining('<ID>VoucherTypes</ID>', { body: fixture('voucher-types.xml') });
  mock.onBodyContaining('<ID>StockItems</ID>', { body: fixture('stock-items-empty.xml') });
  mock.onBodyContaining('<TYPE>Voucher</TYPE>', { body: fixture('day-book-trading.xml') });
  mock.onBodyContaining('<ID>Cash Flow</ID>', { body: fixture('cash-flow.xml') });
  mock.onBodyContaining('<ID>Funds Flow</ID>', { body: fixture('funds-flow.xml') });
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

describe('tally_get_vouchers (family: sales)', () => {
  /**
   * The behaviour these tools exist for. "Tax Invoice" derives from Sales but
   * its name contains neither "sales" nor "invoice-as-sales" — matching on the
   * type name would silently drop it and under-report the period.
   */
  it('includes a custom voucher type resolved by its base type, not its name', async () => {
    const result = await callToolOk(build(), 'tally_get_vouchers', { family: 'sales', ...PERIOD });
    const numbers = (result.items as { voucherNumber: string }[]).map((v) => v.voucherNumber);

    expect(numbers).toEqual(['S-1', 'TI-1']);
    expect(result.voucherTypesIncluded).toEqual(
      expect.arrayContaining(['sales', 'tax invoice'])
    );
  });

  it('excludes other families', async () => {
    const result = await callToolOk(build(), 'tally_get_vouchers', { family: 'sales', ...PERIOD });
    const types = (result.items as { voucherType: string }[]).map((v) => v.voucherType);

    expect(types).not.toContain('Payment');
    expect(types).not.toContain('Purchase');
  });

  /** No summed total: which entry is "the sale" is an interpretation. */
  it('returns no computed total', async () => {
    const result = await callToolOk(build(), 'tally_get_vouchers', { family: 'sales', ...PERIOD });

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

    const result = await callToolOk(build(), 'tally_get_vouchers', { family: 'sales', ...PERIOD });

    // Falls back to the built-in name rather than matching nothing silently.
    expect(result.voucherTypesIncluded).toEqual(['sales']);
    expect((result.warnings as string[]).some((w) => /no voucher types deriving/i.test(w))).toBe(
      true
    );
  });
});

describe('tally_get_vouchers (family: purchases)', () => {
  it('returns only the purchase family', async () => {
    const result = await callToolOk(build(), 'tally_get_vouchers', {
      family: 'purchases',
      ...PERIOD,
    });
    const numbers = (result.items as { voucherNumber: string }[]).map((v) => v.voucherNumber);

    expect(numbers).toEqual(['PU-1']);
  });
});

describe('tally_get_vouchers (family: sales, with filters)', () => {
  it('filters by party', async () => {
    const result = await callToolOk(build(), 'tally_get_vouchers', {
      family: 'sales',
      ...PERIOD,
      party: 'Bramley',
    });

    expect((result.items as { voucherNumber: string }[]).map((v) => v.voucherNumber)).toEqual([
      'S-1',
    ]);
  });

  it('filters by amount using the largest entry', async () => {
    const result = await callToolOk(build(), 'tally_get_vouchers', {
      family: 'sales',
      ...PERIOD,
      minAmount: 10000,
    });

    expect((result.items as { voucherNumber: string }[]).map((v) => v.voucherNumber)).toEqual([
      'S-1',
    ]);
  });

  it('matches a value inside a nested structure', async () => {
    const result = await callToolOk(build(), 'tally_get_vouchers', {
      family: 'sales',
      ...PERIOD,
      fieldMatch: 'New Ref',
    });

    expect((result.items as { voucherNumber: string }[]).map((v) => v.voucherNumber)).toEqual([
      'S-1',
    ]);
  });
});

/**
 * The failure this guards against was observed live: a company whose books are
 * FY 25-26, queried on a date in FY 26-27, returned zero vouchers for every
 * date-defaulted call while holding 453 of them. Silence there reads as "the
 * data is missing" rather than "wrong year".
 */
describe('empty result for a period the caller never chose', () => {
  function serveEmptyRegister(): void {
    mock.onBodyContaining('<TYPE>Voucher</TYPE>', { body: fixture('voucher-register-empty.xml') });
  }

  it('explains the defaulted period and names the company book start date', async () => {
    serveEmptyRegister();

    const result = await callToolOk(build(), 'tally_get_vouchers', {});
    const warning = (result.warnings as string[] | undefined)?.find((w) =>
      w.includes('did not specify')
    );

    expect(result.pagination).toMatchObject({ total: 0 });
    expect(warning).toBeDefined();
    // The company's own start date, and a concrete range to retry with.
    expect(warning).toContain('EXAMPLE TRADING PRIVATE LIMITED');
    expect(warning).toContain('2021-04-01');
    expect(warning).toMatch(/fromDate 2021-04-01 and toDate 2022-03-31/);
  });

  /** The caller chose this empty period, so there is nothing to explain. */
  it('stays silent when the caller supplied the dates', async () => {
    serveEmptyRegister();

    const result = await callToolOk(build(), 'tally_get_vouchers', {
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });

    expect(result.pagination).toMatchObject({ total: 0 });
    expect((result.warnings as string[] | undefined) ?? []).not.toContainEqual(
      expect.stringContaining('did not specify')
    );
  });

  /** A filter matching nothing is a normal answer, not a period problem. */
  it('stays silent when the period has vouchers but a filter excludes them all', async () => {
    // This test needs the DEFAULTED period to actually contain vouchers, and the
    // default is now the company's own book year rather than a hard-coded Indian
    // one. The shared company fixture's books end 2022-03-31 while the voucher
    // fixtures are dated July 2026, so this overrides the company with one whose
    // year covers them. Without the override the defaulted period genuinely IS
    // empty and the note fires correctly — which would assert the opposite of
    // what this test is about.
    mock.onBodyContaining('List of Companies', { body: COMPANY_WITH_CURRENT_BOOKS });

    const result = await callToolOk(build(), 'tally_get_vouchers', {
      party: 'no such party anywhere',
    });

    expect(result.pagination).toMatchObject({ total: 0 });
    expect((result.warnings as string[] | undefined) ?? []).not.toContainEqual(
      expect.stringContaining('did not specify')
    );
  });

  it('covers inventory movements too', async () => {
    serveEmptyRegister();

    const result = await callToolOk(build(), 'tally_get_inventory_movements', {});

    expect(
      (result.warnings as string[] | undefined)?.some((w) => w.includes('did not specify'))
    ).toBe(true);
  });
});

describe('inventory tools', () => {
  /**
   * The company used for verification has no stock. An empty list is the
   * correct answer and must not be an error, nor a phantom item read from the
   * CMPINFO counter.
   */
  it('returns an empty list for a company with no inventory', async () => {
    const result = await callToolOk(build(), 'tally_get_masters', { type: 'stockItem',});

    expect(result.items).toEqual([]);
    expect(result.pagination).toMatchObject({ total: 0 });
  });

  it('does not mistake the CMPINFO counter for a stock item', async () => {
    const result = await callToolOk(build(), 'tally_get_masters', { type: 'stockItem',});
    expect((result.items as unknown[]).length).toBe(0);
  });

  it('explains that the company may keep no inventory when an item is not found', async () => {
    const error = await callToolError(build(), 'tally_get_masters', { type: 'stockItem', name: 'Widget, 12mm' });

    expect(error.code).toBe('TALLY_COMPANY_NOT_FOUND');
    expect(error.suggestion).toMatch(/no stock items at all/i);
  });

  /** Verified live against a company that actually holds stock (2026-08-12). */
  it('promotes balance, value and rate fields for a company that holds stock', async () => {
    mock.onBodyContaining('<ID>StockItems</ID>', { body: fixture('stock-items-populated.xml') });

    const result = await callToolOk(build(), 'tally_get_masters', { type: 'stockItem',});
    const items = result.items as Array<Record<string, unknown>>;

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      name: 'Acetyle-L-Carnitine HCL',
      parent: 'Primary',
      baseUnits: 'Kgs.',
      openingBalance: '1100.00 Kgs.',
      closingBalance: '1000.00 Kgs.',
      closingRate: '20.00/Kgs.',
    });
    expect((items[0]?.closingValue as { amount: string })?.amount).toBe('-20000');
    expect((items[0]?.openingValue as { amount: string })?.amount).toBe('-22000');
    // CATEGORY is "Not Applicable" on both fixture items, so it is identical
    // across the whole page and gets folded to the response-level uniformFields
    // instead of being repeated on every item — see src/utils/uniformFields.ts.
    expect(result.uniformFields).toMatchObject({ CATEGORY: 'Not Applicable' });
    expect(items[0]?.fields).not.toHaveProperty('CATEGORY');
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
    const result = await callToolOk(build(), 'tally_get_outstanding', {
      side: 'receivable',
      ...PERIOD,
    });
    const rows = result.rows ?? result.items;

    expect(result.groupsUsed).toEqual(['Sundry Debtors']);
    // Northwind Retail Limited is the only Sundry Debtor in the fixture, and
    // its balance is zero, so it is excluded by default.
    expect(rows).toEqual([]);
  });

  it('includes zero balances when asked', async () => {
    const result = await callToolOk(build(), 'tally_get_outstanding', {
      side: 'receivable',
      ...PERIOD,
      includeZeroBalances: true,
    });

    expect((result.items as { party: string }[]).map((r) => r.party)).toEqual([
      'Northwind Retail Limited',
    ]);
  });

  it('attaches bill references from the voucher entry, not the voucher party', async () => {
    const result = await callToolOk(build(), 'tally_get_outstanding', {
      side: 'payable',
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
    const result = await callToolOk(build(), 'tally_get_outstanding', {
      side: 'payable',
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
    const result = await callToolOk(build(), 'tally_get_outstanding', {
      side: 'receivable',
      ...PERIOD,
      groups: ['No Such Group'],
    });

    expect((result.warnings as string[]).some((w) => /No ledgers were found/i.test(w))).toBe(true);
  });
});

describe('GST tools', () => {
  it('reports tax ledgers and registration types in use', async () => {
    const result = await callToolOk(build(), 'tally_get_gst', { view: 'summary' });

    expect(result.taxGroupsUsed).toEqual(['Duties & Taxes']);
    expect(result.registrationTypesInUse).toMatchObject({ Regular: 1 });
    expect(result.partiesWithGstin).toBe(1);
  });

  it('returns transactions carrying GST fields, with the fields verbatim', async () => {
    const result = await callToolOk(build(), 'tally_get_gst', { view: 'transactions', ...PERIOD });
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
    const result = await callToolOk(build(), 'tally_get_gst', { view: 'transactions', ...PERIOD });
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
    mock.onBodyContaining('<TYPE>Voucher</TYPE>', {
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

    const result = await callToolOk(build(), 'tally_get_gst', { view: 'transactions', ...PERIOD });

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
    mock.onBodyContaining('<TYPE>Voucher</TYPE>', {
      body: `<ENVELOPE><BODY><DATA><TALLYMESSAGE>
        <VOUCHER VCHTYPE="Payment"><DATE>20260705</DATE><VOUCHERNUMBER>P-8</VOUCHERNUMBER>
          <VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>
          <NUMBERINGSTYLE>Auto Retain</NUMBERINGSTYLE>
        </VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`,
    });

    const result = await callToolOk(build(), 'tally_get_gst', { view: 'transactions', ...PERIOD });
    expect(result.items).toEqual([]);
  });

  it('ignores GST fields whose value is an explicit negative', async () => {
    const result = await callToolOk(build(), 'tally_get_gst', { view: 'transactions', ...PERIOD });
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
    const result = await callToolOk(build(), 'tally_get_gst', { view: 'transactions', ...PERIOD });

    expect(result).not.toHaveProperty('taxLiability');
    expect(result).not.toHaveProperty('totalTax');
    expect(result).not.toHaveProperty('netPayable');
  });
});

describe('cash flow and fund flow', () => {
  interface FlowRow {
    period: string;
    debit: { amount: string } | null;
    credit: { amount: string } | null;
    net: { amount: string } | null;
  }

  it('returns one row per month with Tally three columns preserved', async () => {
    const result = await callToolOk(build(), 'tally_get_statement', { statement: 'cash_flow', ...PERIOD });
    const rows = result.rows as FlowRow[];

    expect(rows.map((row) => row.period)).toEqual(['April', 'May', 'June', 'July']);
    // Sign preserved: the debit column arrives negative and stays negative.
    expect(rows[0]?.debit?.amount).toBe('-1111111.11');
    expect(rows[0]?.credit?.amount).toBe('1000000');
    // Tally's own net column is passed through, not recomputed here.
    expect(rows[0]?.net?.amount).toBe('-111111.11');
  });

  it('echoes the period actually used', async () => {
    const result = await callToolOk(build(), 'tally_get_statement', { statement: 'cash_flow', ...PERIOD });
    expect(result.period).toEqual(PERIOD);
  });

  it('passes the funds flow opening/closing chain through unchanged', async () => {
    const result = await callToolOk(build(), 'tally_get_statement', { statement: 'fund_flow', ...PERIOD });
    const rows = result.rows as FlowRow[];

    // Each month's debit equals the previous month's credit in Tally's own
    // export — opening and closing funds. Nothing is renamed or derived; the
    // fixture preserves the relationship so a regression here means the
    // normaliser started mixing columns up.
    expect(rows[1]?.debit?.amount).toBe(rows[0]?.credit?.amount);
    expect(rows[2]?.debit?.amount).toBe(rows[1]?.credit?.amount);
  });

  it('classifies nothing: no operating/investing/financing split appears', async () => {
    const result = await callToolOk(build(), 'tally_get_statement', { statement: 'cash_flow', ...PERIOD });

    expect(JSON.stringify(result).toLowerCase()).not.toContain('operating');
    expect(JSON.stringify(result).toLowerCase()).not.toContain('investing');
    expect(JSON.stringify(result).toLowerCase()).not.toContain('financing');
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

describe('tally_get_company (includeFeatures)', () => {
  it('infers features from evidence and says so', async () => {
    const result = await callToolOk(build(), 'tally_get_company', { includeFeatures: true });
    const features = result.features as Record<string, { inUse: boolean; evidence: string }> & {
      caveat: string;
    };

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
    expect(features.caveat).toMatch(/not the F11 configuration/i);
  });
});
