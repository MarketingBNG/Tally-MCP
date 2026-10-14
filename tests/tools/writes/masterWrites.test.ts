import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolError,
  callToolOk,
  createToolRegistry,
  fixture,
  makeDeps,
  type ToolRegistry,
} from '../harness.js';
import { registerCreateTools } from '../../../src/tools/create/index.js';
import { registerAlterTools } from '../../../src/tools/alter/index.js';
import { registerConfirmTools } from '../../../src/tools/confirm/register.js';

/**
 * tally_create_master / tally_alter_master: the per-kind rules. Each refusal
 * here is one that would otherwise reach TallyPrime as a request it has to
 * interpret — and an import that TallyPrime interprets generously changes books.
 */

const COMPANY = 'Test Books LLC';
const COMPANY_LIST = `<ENVELOPE><BODY><DATA><COLLECTION>
  <COMPANY NAME="${COMPANY}"><STARTINGFROM>20250401</STARTINGFROM><ENDINGAT>20260331</ENDINGAT>
  <NAME>${COMPANY}</NAME><CURRENCYNAME>$</CURRENCYNAME></COMPANY>
</COLLECTION></DATA></BODY></ENVELOPE>`;
const GROUPS = `<ENVELOPE><BODY><DATA><COLLECTION>
  <GROUP NAME="Indirect Expenses"><PARENT></PARENT></GROUP>
</COLLECTION></DATA></BODY></ENVELOPE>`;
const UNITS = `<ENVELOPE><BODY><DATA><COLLECTION><UNIT NAME="kg"><NAME>kg</NAME></UNIT></COLLECTION></DATA></BODY></ENVELOPE>`;
const STOCK_GROUPS = `<ENVELOPE><BODY><DATA><COLLECTION><STOCKGROUP NAME="Raw Material"><PARENT>Primary</PARENT></STOCKGROUP></COLLECTION></DATA></BODY></ENVELOPE>`;
const EMPTY = '<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>';

let mock: MockTallyServer;
let port: number;
let registry: ToolRegistry;

function imports(): string[] {
  return mock.requests.map((r) => r.body).filter((b) => b.includes('<TALLYREQUEST>Import Data'));
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
  // Later registrations win, so the catch-all goes first.
  mock.onBodyContaining('Masters</ID>', { body: EMPTY });
  mock.onBodyContaining('<TALLYREQUEST>Import Data', { body: fixture('import-created.xml') });
  mock.onBodyContaining('TallyMcpCompanies', { body: COMPANY_LIST });
  mock.onBodyContaining('<ID>Groups</ID>', { body: GROUPS });
  mock.onBodyContaining('<ID>UnitMasters</ID>', { body: UNITS });
  mock.onBodyContaining('<ID>StockGroupMasters</ID>', { body: STOCK_GROUPS });
  mock.onBodyContaining('<ID>StockItems</ID>', { body: EMPTY });
  mock.onBodyContaining('<ID>VoucherTypes</ID>', {
    body: '<ENVELOPE><BODY><DATA><COLLECTION><VOUCHERTYPE NAME="Sales"><PARENT>Sales</PARENT></VOUCHERTYPE></COLLECTION></DATA></BODY></ENVELOPE>',
  });

  registry = createToolRegistry();
  const deps = makeDeps(port, {
    TALLY_WRITE_LOG_PATH: join(mkdtempSync(join(tmpdir(), 'tally-master-log-')), 'log.jsonl'),
  });
  registerCreateTools(registry.server, deps);
  registerAlterTools(registry.server, deps);
  registerConfirmTools(registry.server, deps);
});

describe('tally_create_master', () => {
  it('values opening stock as a debit — negative in TallyPrime\'s sign', async () => {
    const preview = await callToolOk(registry, 'tally_create_master', {
      kind: 'stockItem',
      name: 'Copper Wire',
      parent: 'raw material',
      baseUnits: 'KG',
      openingQuantity: 4,
      openingRate: 12.5,
    });
    expect(preview.opening).toBe('4 kg @ 12.50 = 50.00 Dr');

    await callToolOk(registry, 'tally_confirm_write', { confirmToken: preview.confirmToken });
    const sent = imports()[0] ?? '';
    expect(sent).toContain('<STOCKITEM NAME="Copper Wire" ACTION="Create">');
    expect(sent).toContain('<PARENT>Raw Material</PARENT>');
    expect(sent).toContain('<OPENINGBALANCE>4 kg</OPENINGBALANCE>');
    expect(sent).toContain('<OPENINGVALUE>-50</OPENINGVALUE>');
  });

  it('refuses a field the kind does not take', async () => {
    const error = await callToolError(registry, 'tally_create_master', {
      kind: 'godown',
      name: 'Store',
      baseUnits: 'kg',
    });
    expect(error.message).toMatch(/godown does not take: baseUnits/);
  });

  it('refuses a group with no parent, and a stock item with no unit', async () => {
    expect((await callToolError(registry, 'tally_create_master', { kind: 'group', name: 'X' })).message).toMatch(/needs a parent/);
    expect((await callToolError(registry, 'tally_create_master', { kind: 'stockItem', name: 'X' })).message).toMatch(/needs baseUnits/);
  });

  it('refuses a unit that does not exist', async () => {
    const error = await callToolError(registry, 'tally_create_master', {
      kind: 'stockItem',
      name: 'X',
      baseUnits: 'tonne',
    });
    expect(error.message).toMatch(/no unit named "tonne"/);
  });

  it('refuses an existing name', async () => {
    const error = await callToolError(registry, 'tally_create_master', {
      kind: 'unit',
      name: 'kg',
    });
    expect(error.message).toMatch(/already exists/);
    expect(imports()).toEqual([]);
  });
});

describe('tally_alter_master', () => {
  it('refuses to rename a unit', async () => {
    const error = await callToolError(registry, 'tally_alter_master', { kind: 'unit', name: 'kg', newName: 'kgs' });
    expect(error.message).toMatch(/cannot be renamed/);
  });

  it('treats "Primary" and empty as the same top level, so nothing changes', async () => {
    const error = await callToolError(registry, 'tally_alter_master', { kind: 'stockGroup', name: 'Raw Material', parent: '' });
    expect(error.message).toMatch(/Nothing to change/);
  });
});

describe('voucher types and budgets', () => {
  it('creates a voucher type based on an existing one, with its numbering method', async () => {
    const preview = await callToolOk(registry, 'tally_create_master', {
      kind: 'voucherType',
      name: 'Export Invoice',
      parent: 'sales',
      numberingMethod: 'Manual',
    });
    await callToolOk(registry, 'tally_confirm_write', { confirmToken: preview.confirmToken }).catch(() => undefined);
    const sent = imports()[0] ?? '';
    expect(sent).toContain('<VOUCHERTYPE NAME="Export Invoice" ACTION="Create">');
    expect(sent).toContain('<ISACTIVE>Yes</ISACTIVE><PARENT>Sales</PARENT>');
    expect(sent).toContain('<NUMBERINGMETHOD>Manual</NUMBERINGMETHOD>');
  });

  it('refuses a voucher type with no base type', async () => {
    const error = await callToolError(registry, 'tally_create_master', { kind: 'voucherType', name: 'X' });
    expect(error.message).toMatch(/needs a parent/);
  });

  it('refuses a numbering change on alter — TallyPrime ignores it (verified live)', async () => {
    const error = await callToolError(registry, 'tally_alter_master', {
      kind: 'voucherType',
      name: 'Sales',
      numberingMethod: 'Automatic',
    });
    expect(error.message).toMatch(/does not change a voucher type's numbering method/);
  });

  it('creates a budget by name only', async () => {
    const preview = await callToolOk(registry, 'tally_create_master', { kind: 'budget', name: 'FY Plan' });
    await callToolOk(registry, 'tally_confirm_write', { confirmToken: preview.confirmToken }).catch(() => undefined);
    expect(imports()[0]).toContain('<BUDGET NAME="FY Plan" ACTION="Create"><NAME.LIST TYPE="String"><NAME>FY Plan</NAME></NAME.LIST></BUDGET>');
  });
});
