import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolEnvelope,
  callToolError,
  callToolOk,
  createToolRegistry,
  fixture,
  makeDeps,
  type ToolRegistry,
} from '../harness.js';
import { registerCreateTools } from '../../../src/tools/create/index.js';
import { registerAlterTools } from '../../../src/tools/alter/index.js';
import { registerDeleteTools } from '../../../src/tools/delete/index.js';
import { registerConfirmTools } from '../../../src/tools/confirm/register.js';

/**
 * The ledger write tools, end to end against a mock that keeps state the way
 * TallyPrime does: an import changes what the next ledger read returns.
 *
 * What is pinned here is the safety argument, not just the happy path —
 * a preview writes nothing, a token sends once, a timeout is never retried,
 * and "TallyPrime said ERRORS 0" is never mistaken for success.
 */

const COMPANY = 'Test Books LLC';
const COMPANY_LIST = `<ENVELOPE><BODY><DATA><COLLECTION>
  <COMPANY NAME="${COMPANY}" RESERVEDNAME="">
    <STARTINGFROM TYPE="Date">20250401</STARTINGFROM>
    <ENDINGAT TYPE="Date">20260331</ENDINGAT>
    <NAME TYPE="String">${COMPANY}</NAME>
    <CURRENCYNAME TYPE="String">$</CURRENCYNAME>
    <COUNTRYNAME TYPE="String">United States of America</COUNTRYNAME>
  </COMPANY>
</COLLECTION></DATA></BODY></ENVELOPE>`;

const GROUPS = `<ENVELOPE><BODY><DATA><COLLECTION>
  <GROUP NAME="Indirect Expenses"><PARENT></PARENT><ISREVENUE>Yes</ISREVENUE><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></GROUP>
  <GROUP NAME="Sundry Debtors"><PARENT>Current Assets</PARENT><ISREVENUE>No</ISREVENUE><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></GROUP>
</COLLECTION></DATA></BODY></ENVELOPE>`;

interface FakeLedger {
  name: string;
  parent: string;
  opening: string;
}

let mock: MockTallyServer;
let port: number;
let ledgers: FakeLedger[];
let importReply: (body: string) => { body: string; delayMs?: number };

function ledgerXml(): string {
  const rows = ledgers
    .map(
      (l) =>
        `<LEDGER NAME="${l.name}" RESERVEDNAME=""><PARENT TYPE="String">${l.parent}</PARENT>` +
        `<OPENINGBALANCE TYPE="Amount">${l.opening}</OPENINGBALANCE>` +
        `<CLOSINGBALANCE TYPE="Amount">${l.opening}</CLOSINGBALANCE></LEDGER>`
    )
    .join('');
  return `<ENVELOPE><BODY><DATA><COLLECTION>${rows}</COLLECTION></DATA></BODY></ENVELOPE>`;
}

/** Apply a ledger import the way TallyPrime would, for the read-back. */
function applyImport(body: string): void {
  const action = /ACTION="(\w+)"/.exec(body)?.[1];
  const name = /<LEDGER NAME="([^"]+)"/.exec(body)?.[1] ?? '';
  const listed = /<NAME>([^<]+)<\/NAME>/.exec(body)?.[1] ?? name;
  const parent = /<PARENT>([^<]*)<\/PARENT>/.exec(body)?.[1];
  const opening = /<OPENINGBALANCE>([^<]*)<\/OPENINGBALANCE>/.exec(body)?.[1];
  const existing = ledgers.find((l) => l.name === name);

  if (action === 'Delete') ledgers = ledgers.filter((l) => l.name !== name);
  else if (action === 'Create' && existing === undefined) {
    ledgers.push({ name: listed, parent: parent ?? '', opening: opening ?? '0.00' });
  } else if (existing !== undefined) {
    existing.name = listed;
    if (parent !== undefined) existing.parent = parent;
    if (opening !== undefined) existing.opening = opening;
  }
}

function imports(): string[] {
  return mock.requests.map((r) => r.body).filter((b) => b.includes('<TALLYREQUEST>Import Data'));
}

let registry: ToolRegistry;
let logPath: string;

function freshRegistry(overrides: Record<string, string> = {}): ToolRegistry {
  const reg = createToolRegistry();
  const deps = makeDeps(port, { TALLY_WRITE_LOG_PATH: logPath, ...overrides });
  registerCreateTools(reg.server, deps);
  registerAlterTools(reg.server, deps);
  registerDeleteTools(reg.server, deps);
  registerConfirmTools(reg.server, deps);
  return reg;
}

beforeAll(async () => {
  mock = new MockTallyServer();
  port = await mock.start();
});

afterAll(async () => {
  await mock.stop();
});

beforeEach(() => {
  ledgers = [{ name: 'Office Rent', parent: 'Indirect Expenses', opening: '0.00' }];
  importReply = (body) => {
    applyImport(body);
    const action = /ACTION="(\w+)"/.exec(body)?.[1];
    return {
      body:
        action === 'Delete'
          ? fixture('import-deleted.xml')
          : action === 'Alter'
            ? fixture('import-create-existing-altered.xml')
            : fixture('import-created.xml'),
    };
  };
  mock.reset();
  mock.onBodyContaining('<TALLYREQUEST>Import Data', (body) => importReply(body));
  mock.onBodyContaining('List of Companies', { body: COMPANY_LIST });
  mock.onBodyContaining('<ID>Ledgers</ID>', () => ({ body: ledgerXml() }));
  mock.onBodyContaining('<ID>Groups</ID>', { body: GROUPS });
  logPath = join(mkdtempSync(join(tmpdir(), 'tally-write-log-')), 'write-log.jsonl');
  registry = freshRegistry();
});

describe('tally_create_ledger', () => {
  it('previews without sending anything to TallyPrime', async () => {
    const preview = await callToolOk(registry, 'tally_create_ledger', {
      name: 'Audit Fees',
      group: 'indirect expenses',
    });

    expect(preview.status).toMatch(/PREVIEW ONLY/);
    expect(preview.group).toBe('Indirect Expenses');
    expect(typeof preview.confirmToken).toBe('string');
    expect(imports()).toEqual([]);
  });

  it('sends exactly the previewed write once on confirm, and reads it back', async () => {
    const preview = await callToolOk(registry, 'tally_create_ledger', {
      name: 'Audit Fees',
      group: 'Indirect Expenses',
      openingBalance: '500',
      openingSide: 'Dr',
    });
    const result = await callToolOk(registry, 'tally_confirm_write', {
      confirmToken: preview.confirmToken,
    });

    expect(result.status).toMatch(/^WRITTEN and confirmed/);
    const sent = imports();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(`<SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY>`);
    expect(sent[0]).toContain('<LEDGER NAME="Audit Fees" ACTION="Create">');
    // A debit is NEGATIVE in TallyPrime's own encoding.
    expect(sent[0]).toContain('<OPENINGBALANCE>-500</OPENINGBALANCE>');
  });

  it('refuses a second confirm of the same token', async () => {
    const preview = await callToolOk(registry, 'tally_create_ledger', {
      name: 'Audit Fees',
      group: 'Indirect Expenses',
    });
    await callToolOk(registry, 'tally_confirm_write', { confirmToken: preview.confirmToken });
    const again = await callToolError(registry, 'tally_confirm_write', {
      confirmToken: preview.confirmToken,
    });

    expect(again.code).toBe('WRITE_TOKEN_INVALID');
    expect(imports()).toHaveLength(1);
  });

  it('refuses a name that already exists, because Create would silently alter it', async () => {
    const error = await callToolError(registry, 'tally_create_ledger', {
      name: 'office rent',
      group: 'Indirect Expenses',
    });

    expect(error.code).toBe('INVALID_PARAMETERS');
    expect(error.message).toContain('Office Rent');
    expect(imports()).toEqual([]);
  });

  it('refuses a group that does not exist', async () => {
    const error = await callToolError(registry, 'tally_create_ledger', {
      name: 'Audit Fees',
      group: 'No Such Group',
    });
    expect(error.code).toBe('INVALID_PARAMETERS');
  });

  it('refuses at confirm when the ledger appeared after the preview', async () => {
    const preview = await callToolOk(registry, 'tally_create_ledger', {
      name: 'Audit Fees',
      group: 'Indirect Expenses',
    });
    ledgers.push({ name: 'Audit Fees', parent: 'Indirect Expenses', opening: '0.00' });

    const error = await callToolError(registry, 'tally_confirm_write', {
      confirmToken: preview.confirmToken,
    });
    expect(error.code).toBe('WRITE_CONFLICT');
    expect(imports()).toEqual([]);
  });

  it('treats ALTERED on a create as an unexpected change, not a success', async () => {
    importReply = () => ({ body: fixture('import-create-existing-altered.xml') });
    const preview = await callToolOk(registry, 'tally_create_ledger', {
      name: 'Audit Fees',
      group: 'Indirect Expenses',
    });
    const error = await callToolError(registry, 'tally_confirm_write', {
      confirmToken: preview.confirmToken,
    });

    expect(error.code).toBe('WRITE_CONFLICT');
    expect(error.message).toMatch(/CHANGED THE BOOKS DIFFERENTLY/);
  });

  it('reports a LINEERROR as a rejection with TallyPrime\'s own words', async () => {
    importReply = () => ({ body: fixture('import-line-error.xml') });
    const preview = await callToolOk(registry, 'tally_create_ledger', {
      name: 'Audit Fees',
      group: 'Indirect Expenses',
    });
    const error = await callToolError(registry, 'tally_confirm_write', {
      confirmToken: preview.confirmToken,
    });

    expect(error.code).toBe('WRITE_REJECTED');
    expect(error.message).toContain("Group 'MCP No Such Group' does not exist!");
  });

  it('never retries a write that timed out, and says the outcome is unknown', async () => {
    const slow = freshRegistry({ TALLY_TIMEOUT_MS: '1000', TALLY_TIMEOUT_RETRIES: '2' });
    importReply = () => ({ body: fixture('import-created.xml'), delayMs: 1500 });
    const preview = await callToolOk(slow, 'tally_create_ledger', {
      name: 'Audit Fees',
      group: 'Indirect Expenses',
    });
    const error = await callToolError(slow, 'tally_confirm_write', {
      confirmToken: preview.confirmToken,
    });

    expect(error.code).toBe('WRITE_OUTCOME_UNKNOWN');
    expect(imports()).toHaveLength(1);
  });

  it('records every confirmed write in the write log', async () => {
    const preview = await callToolOk(registry, 'tally_create_ledger', {
      name: 'Audit Fees',
      group: 'Indirect Expenses',
    });
    await callToolOk(registry, 'tally_confirm_write', { confirmToken: preview.confirmToken });

    expect(existsSync(logPath)).toBe(true);
    const entry = JSON.parse(readFileSync(logPath, 'utf8').trim()) as Record<string, unknown>;
    expect(entry.outcome).toBe('WRITTEN');
    expect(entry.company).toBe(COMPANY);
    expect(entry.requestXml).toContain('ACTION="Create"');

    const listed = await callToolOk(registry, 'tally_list_write_log', {});
    expect((listed.entries as unknown[]).length).toBe(1);
  });
});

describe('ledger party details', () => {
  it('sends address details in the dated mailing block, never the top-level tags Tally ignores', async () => {
    const preview = await callToolOk(registry, 'tally_create_ledger', {
      name: 'Acme Corp',
      group: 'Sundry Debtors',
      address: ['1 Main St'],
      state: 'Michigan',
      pincode: '48226',
    });
    await callToolEnvelope(registry, 'tally_confirm_write', { confirmToken: preview.confirmToken });
    const sent = imports()[0] ?? '';

    expect(sent).toContain('<LEDMAILINGDETAILS.LIST><ADDRESS.LIST TYPE="String"><ADDRESS>1 Main St</ADDRESS></ADDRESS.LIST><APPLICABLEFROM>20250401</APPLICABLEFROM><PINCODE>48226</PINCODE><STATE>Michigan</STATE></LEDMAILINGDETAILS.LIST>');
    expect(sent).not.toContain('<LEDSTATENAME>');
    expect(sent).not.toMatch(/<PINCODE>[^<]*<\/PINCODE><\/LEDGER>/);
  });

  it('does not call a write confirmed when the details are not in the books', async () => {
    // This mock stores no mailing details — exactly what TallyPrime did with the old tags.
    const preview = await callToolOk(registry, 'tally_create_ledger', {
      name: 'Acme Corp',
      group: 'Sundry Debtors',
      state: 'Michigan',
    });
    const result = await callToolOk(registry, 'tally_confirm_write', { confirmToken: preview.confirmToken });

    expect(result.status).toMatch(/did NOT show the expected result/);
    expect(JSON.stringify(result.readBack)).toContain('detailsNotStored');
  });
});

describe('tally_alter_ledger and tally_delete_ledger', () => {
  it('renames a ledger, keeping the current name in NAME and the new one in NAME.LIST', async () => {
    const preview = await callToolOk(registry, 'tally_alter_ledger', {
      name: 'Office Rent',
      newName: 'Office Rent - HQ',
    });
    expect(preview.changes).toEqual({ name: { from: 'Office Rent', to: 'Office Rent - HQ' } });

    const result = await callToolOk(registry, 'tally_confirm_write', {
      confirmToken: preview.confirmToken,
    });
    expect(result.status).toMatch(/^WRITTEN and confirmed/);
    expect(imports()[0]).toContain('<LEDGER NAME="Office Rent" ACTION="Alter">');
    expect(imports()[0]).toContain('<NAME>Office Rent - HQ</NAME>');
  });

  it('explains a "Cannot be deleted!" refusal instead of passing it on bare', async () => {
    importReply = () => ({
      body:
        '<RESPONSE><LINEERROR>Cannot be deleted!</LINEERROR><CREATED>0</CREATED><ALTERED>0</ALTERED>' +
        '<DELETED>0</DELETED><LASTVCHID>0</LASTVCHID><LASTMID>0</LASTMID><COMBINED>0</COMBINED>' +
        '<IGNORED>0</IGNORED><ERRORS>1</ERRORS><CANCELLED>0</CANCELLED><EXCEPTIONS>0</EXCEPTIONS></RESPONSE>',
    });
    const preview = await callToolOk(registry, 'tally_delete_ledger', { name: 'Office Rent' });
    const error = await callToolError(registry, 'tally_confirm_write', { confirmToken: preview.confirmToken });

    expect(error.code).toBe('WRITE_REJECTED');
    expect(error.message).toMatch(/TallyPrime gives no reason here/);
  });

  it('refuses an alter that changes nothing', async () => {
    const error = await callToolError(registry, 'tally_alter_ledger', {
      name: 'Office Rent',
      group: 'Indirect Expenses',
    });
    expect(error.code).toBe('INVALID_PARAMETERS');
  });

  it('deletes a ledger and confirms it is gone', async () => {
    const preview = await callToolOk(registry, 'tally_delete_ledger', { name: 'Office Rent' });
    const result = await callToolOk(registry, 'tally_confirm_write', {
      confirmToken: preview.confirmToken,
    });

    expect(result.status).toMatch(/^WRITTEN and confirmed/);
    expect(ledgers).toEqual([]);
  });
});
