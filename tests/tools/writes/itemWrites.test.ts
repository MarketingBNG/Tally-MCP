import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolError,
  callToolOk,
  createToolRegistry,
  makeDeps,
  type ToolRegistry,
} from '../harness.js';
import { registerCreateTools } from '../../../src/tools/create/index.js';
import { registerAlterTools } from '../../../src/tools/alter/index.js';
import { registerConfirmTools } from '../../../src/tools/confirm/register.js';

/**
 * Item invoices, cost-centre splits and stock journals, against a mock shaped
 * like what TallyPrime stored and read back live on 2026-10-14 (Probotix).
 */

const COMPANY = 'Test Books LLC';
const GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-0000012c';
const COMPANY_LIST = `<ENVELOPE><BODY><DATA><COLLECTION>
  <COMPANY NAME="${COMPANY}"><STARTINGFROM>20250401</STARTINGFROM><ENDINGAT>20260331</ENDINGAT>
  <NAME>${COMPANY}</NAME><CURRENCYNAME>$</CURRENCYNAME></COMPANY>
</COLLECTION></DATA></BODY></ENVELOPE>`;
const GROUPS = `<ENVELOPE><BODY><DATA><COLLECTION>
  <GROUP NAME="Sundry Debtors"><PARENT>Current Assets</PARENT></GROUP>
  <GROUP NAME="Sales Accounts"><PARENT></PARENT></GROUP>
  <GROUP NAME="Indirect Expenses"><PARENT></PARENT></GROUP>
</COLLECTION></DATA></BODY></ENVELOPE>`;
const LEDGERS = `<ENVELOPE><BODY><DATA><COLLECTION>
  <LEDGER NAME="Acme"><PARENT>Sundry Debtors</PARENT></LEDGER>
  <LEDGER NAME="Local Sales"><PARENT>Sales Accounts</PARENT></LEDGER>
  <LEDGER NAME="Rent"><PARENT>Indirect Expenses</PARENT></LEDGER>
</COLLECTION></DATA></BODY></ENVELOPE>`;
const TYPES = `<ENVELOPE><BODY><DATA><COLLECTION>
  <VOUCHERTYPE NAME="Sales"><PARENT>Sales</PARENT></VOUCHERTYPE>
  <VOUCHERTYPE NAME="Journal"><PARENT>Journal</PARENT></VOUCHERTYPE>
  <VOUCHERTYPE NAME="Stock Journal"><PARENT>Stock Journal</PARENT></VOUCHERTYPE>
</COLLECTION></DATA></BODY></ENVELOPE>`;
const ITEMS = `<ENVELOPE><BODY><DATA><COLLECTION>
  <STOCKITEM NAME="Widget"><PARENT></PARENT><BASEUNITS>nos</BASEUNITS></STOCKITEM>
  <STOCKITEM NAME="Consulting"><PARENT></PARENT><BASEUNITS>Not Applicable</BASEUNITS></STOCKITEM>
</COLLECTION></DATA></BODY></ENVELOPE>`;
const UNITS = `<ENVELOPE><BODY><DATA><COLLECTION>
  <UNIT NAME="nos"><DECIMALPLACES>0</DECIMALPLACES></UNIT>
</COLLECTION></DATA></BODY></ENVELOPE>`;
const GODOWNS = `<ENVELOPE><BODY><DATA><COLLECTION>
  <GODOWN NAME="Main Location"><PARENT></PARENT></GODOWN>
  <GODOWN NAME="Bay 2"><PARENT></PARENT></GODOWN>
</COLLECTION></DATA></BODY></ENVELOPE>`;
const CENTRES = `<ENVELOPE><BODY><DATA><COLLECTION>
  <COSTCENTRE NAME="North"><PARENT></PARENT><CATEGORY>Primary Cost Category</CATEGORY></COSTCENTRE>
  <COSTCENTRE NAME="South"><PARENT></PARENT><CATEGORY>Primary Cost Category</CATEGORY></COSTCENTRE>
</COLLECTION></DATA></BODY></ENVELOPE>`;

/** The sale as TallyPrime stores it: party and sales ledger entries, one item line. */
function storedSale(quantity: string, amount: string): string {
  return `<ENVELOPE><BODY><DATA><COLLECTION>
  <VOUCHER VCHTYPE="Sales"><GUID>${GUID}</GUID><MASTERID>300</MASTERID><ALTERID>9</ALTERID>
    <DATE>20250901</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>1</VOUCHERNUMBER>
    <PARTYLEDGERNAME>Acme</PARTYLEDGERNAME><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Acme</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${amount}</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Local Sales</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${amount}</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Widget</STOCKITEMNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <RATE>10.00/nos</RATE><AMOUNT>${amount}</AMOUNT><ACTUALQTY> ${quantity} nos</ACTUALQTY><BILLEDQTY> ${quantity} nos</BILLEDQTY>
    </ALLINVENTORYENTRIES.LIST>
  </VOUCHER></COLLECTION></DATA></BODY></ENVELOPE>`;
}

const CREATED_REPLY =
  '<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><DELETED>0</DELETED><LASTVCHID>300</LASTVCHID><LASTMID>0</LASTMID><COMBINED>0</COMBINED><IGNORED>0</IGNORED><ERRORS>0</ERRORS><CANCELLED>0</CANCELLED><EXCEPTIONS>0</EXCEPTIONS></RESPONSE>';

let mock: MockTallyServer;
let port: number;
let registry: ToolRegistry;
let stored = storedSale('3', '30.00');

beforeAll(async () => {
  mock = new MockTallyServer();
  port = await mock.start();
});

afterAll(async () => {
  await mock.stop();
});

beforeEach(() => {
  stored = '<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>';
  mock.reset();
  mock.onBodyContaining('<TALLYREQUEST>Import Data', () => {
    stored = storedSale('3', '30.00');
    return {
      body: CREATED_REPLY,
    };
  });
  mock.onBodyContaining('TallyMcpCompanies', { body: COMPANY_LIST });
  mock.onBodyContaining('<ID>Ledgers</ID>', { body: LEDGERS });
  mock.onBodyContaining('<ID>Groups</ID>', { body: GROUPS });
  mock.onBodyContaining('<ID>VoucherTypes</ID>', { body: TYPES });
  mock.onBodyContaining('<ID>StockItems</ID>', { body: ITEMS });
  mock.onBodyContaining('<ID>UnitMasters</ID>', { body: UNITS });
  mock.onBodyContaining('<ID>GodownMasters</ID>', { body: GODOWNS });
  mock.onBodyContaining('<ID>CostCentreMasters</ID>', { body: CENTRES });
  mock.onBodyContaining('<ID>AllVouchers</ID>', () => ({ body: stored }));

  registry = createToolRegistry();
  const deps = makeDeps(port, {
    TALLY_WRITE_LOG_PATH: join(mkdtempSync(join(tmpdir(), 'tally-item-log-')), 'log.jsonl'),
  });
  registerCreateTools(registry.server, deps);
  registerAlterTools(registry.server, deps);
  registerConfirmTools(registry.server, deps);
});

const imports = (): string[] =>
  mock.requests.map((r) => r.body).filter((b) => b.includes('<TALLYREQUEST>Import Data'));

const SALE = {
  voucherType: 'Sales',
  date: '2025-09-01',
  partyLedger: 'Acme',
  entries: [{ ledger: 'Acme', side: 'Dr', amount: '30' }],
  items: [{ item: 'Widget', quantity: 3, rate: 10, ledger: 'Local Sales' }],
};

describe('item invoices', () => {
  it('sends the invoice form TallyPrime stores: item lines with their ledger and godown', async () => {
    const preview = await callToolOk(registry, 'tally_create_voucher', SALE);
    expect((preview.items as Record<string, string>[])[0]).toMatchObject({
      item: 'Widget',
      quantity: '3 nos',
      amount: '30.00',
      side: 'Cr',
      ledger: 'Local Sales',
      godown: 'Main Location',
    });

    const result = await callToolOk(registry, 'tally_confirm_write', { confirmToken: preview.confirmToken });
    expect(result.status).toMatch(/^WRITTEN and confirmed/);
    const sent = imports()[0] ?? '';
    expect(sent).toContain('OBJVIEW="Invoice Voucher View"');
    expect(sent).toContain('<LEDGERENTRIES.LIST><LEDGERNAME>Acme</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>-30</AMOUNT>');
    expect(sent).toContain('<STOCKITEMNAME>Widget</STOCKITEMNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><RATE>10/nos</RATE><AMOUNT>30</AMOUNT><ACTUALQTY>3 nos</ACTUALQTY>');
    expect(sent).toContain('<GODOWNNAME>Main Location</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME>');
    expect(sent).toContain('<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Local Sales</LEDGERNAME>');
  });

  it('does not report success when the stored quantity differs from what was sent', async () => {
    mock.onBodyContaining('<TALLYREQUEST>Import Data', () => {
      stored = storedSale('4', '30.00');
      return { body: CREATED_REPLY };
    });
    const preview = await callToolOk(registry, 'tally_create_voucher', SALE);
    const result = await callToolOk(registry, 'tally_confirm_write', { confirmToken: preview.confirmToken });
    expect(result.status).toMatch(/did NOT show the expected result/);
  });

  it('refuses a quantity finer than the unit keeps — TallyPrime would round it', async () => {
    const error = await callToolError(registry, 'tally_create_voucher', {
      ...SALE,
      entries: [{ ledger: 'Acme', side: 'Dr', amount: '25' }],
      items: [{ item: 'Widget', quantity: 2.5, rate: 10, ledger: 'Local Sales' }],
    });
    expect(error.message).toMatch(/0 decimal place/);
  });

  it('refuses items on a type that does not move stock', async () => {
    const error = await callToolError(registry, 'tally_create_voucher', { ...SALE, voucherType: 'Journal' });
    expect(error.message).toMatch(/does not take stock items/);
  });

  it('refuses an item with no unit, an unknown godown, and an unbalanced invoice', async () => {
    const noUnit = await callToolError(registry, 'tally_create_voucher', {
      ...SALE,
      items: [{ item: 'Consulting', quantity: 3, rate: 10, ledger: 'Local Sales' }],
    });
    expect(noUnit.message).toMatch(/no unit of measure/);
    const godown = await callToolError(registry, 'tally_create_voucher', {
      ...SALE,
      items: [{ ...SALE.items[0], godown: 'Nowhere' }],
    });
    expect(godown.code).toBe('INVALID_PARAMETERS');
    const unbalanced = await callToolError(registry, 'tally_create_voucher', {
      ...SALE,
      entries: [{ ledger: 'Acme', side: 'Dr', amount: '31' }],
    });
    expect(unbalanced.message).toMatch(/do not equal credits/);
    expect(imports()).toEqual([]);
  });

  it('refuses to alter an item invoice with ledger lines only — that would drop its stock', async () => {
    stored = storedSale('3', '30.00');
    const error = await callToolError(registry, 'tally_alter_voucher', {
      guid: GUID,
      currentDate: '2025-09-01',
      voucherType: 'Sales',
      date: '2025-09-01',
      entries: [
        { ledger: 'Acme', side: 'Dr', amount: '30' },
        { ledger: 'Local Sales', side: 'Cr', amount: '30' },
      ],
    });
    expect(error.message).toMatch(/would remove its stock movement/);
  });
});

describe('cost centres', () => {
  const JOURNAL = {
    voucherType: 'Journal',
    date: '2025-09-01',
    entries: [
      { ledger: 'Rent', side: 'Dr', amount: '100', costCentres: [{ name: 'North', amount: '60' }, { name: 'South', amount: '40' }] },
      { ledger: 'Acme', side: 'Cr', amount: '100' },
    ],
  };

  it('sends the split under its category, in the line\'s sign', async () => {
    const preview = await callToolOk(registry, 'tally_create_voucher', JOURNAL);
    await callToolOk(registry, 'tally_confirm_write', { confirmToken: preview.confirmToken }).catch(() => undefined);
    const sent = imports()[0] ?? '';
    expect(sent).toContain(
      '<CATEGORYALLOCATIONS.LIST><CATEGORY>Primary Cost Category</CATEGORY><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>' +
        '<COSTCENTREALLOCATIONS.LIST><NAME>North</NAME><AMOUNT>-60</AMOUNT></COSTCENTREALLOCATIONS.LIST>' +
        '<COSTCENTREALLOCATIONS.LIST><NAME>South</NAME><AMOUNT>-40</AMOUNT></COSTCENTREALLOCATIONS.LIST>'
    );
  });

  it('refuses shares that do not add up to the line', async () => {
    const error = await callToolError(registry, 'tally_create_voucher', {
      ...JOURNAL,
      entries: [{ ...JOURNAL.entries[0], costCentres: [{ name: 'North', amount: '60' }, { name: 'South', amount: '30' }] }, JOURNAL.entries[1]],
    });
    expect(error.message).toMatch(/add up to 90\.00, not the line amount 100\.00/);
  });

  it('refuses an unknown cost centre', async () => {
    const error = await callToolError(registry, 'tally_create_voucher', {
      ...JOURNAL,
      entries: [{ ...JOURNAL.entries[0], costCentres: [{ name: 'West' }] }, JOURNAL.entries[1]],
    });
    expect(error.code).toBe('INVALID_PARAMETERS');
  });
});

describe('tally_create_stock_journal', () => {
  const TRANSFER = {
    date: '2025-09-01',
    consumed: [{ item: 'Widget', quantity: 2, rate: 10, godown: 'Main Location' }],
    produced: [{ item: 'Widget', quantity: 2, rate: 10, godown: 'Bay 2' }],
  };

  it('moves stock out of one godown and into another', async () => {
    const preview = await callToolOk(registry, 'tally_create_stock_journal', TRANSFER);
    expect(preview.warnings).toBeUndefined();
    await callToolOk(registry, 'tally_confirm_write', { confirmToken: preview.confirmToken }).catch(() => undefined);
    const sent = imports()[0] ?? '';
    expect(sent).toContain('OBJVIEW="Consumption Voucher View"');
    expect(sent).toMatch(/<INVENTORYENTRIESOUT\.LIST>.*<AMOUNT>20\.00<\/AMOUNT>.*<GODOWNNAME>Main Location<\/GODOWNNAME>/);
    expect(sent).toMatch(/<INVENTORYENTRIESIN\.LIST>.*<AMOUNT>-20\.00<\/AMOUNT>.*<GODOWNNAME>Bay 2<\/GODOWNNAME>/);
  });

  it('warns when stock out and in are valued differently', async () => {
    const preview = await callToolOk(registry, 'tally_create_stock_journal', {
      ...TRANSFER,
      produced: [{ item: 'Widget', quantity: 2, rate: 12, godown: 'Bay 2' }],
    });
    expect(String(preview.warnings)).toMatch(/valued at 20\.00 .* 24\.00/);
  });

  it('refuses a type that is not a stock journal', async () => {
    const error = await callToolError(registry, 'tally_create_stock_journal', { ...TRANSFER, voucherType: 'Journal' });
    expect(error.message).toMatch(/not a stock journal type/);
  });
});
