import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetEducationalMode } from '../../../src/tools/shared/educationalMode.js';
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
import { registerCancelTools } from '../../../src/tools/cancel/index.js';
import { registerDeleteTools } from '../../../src/tools/delete/index.js';
import { registerConfirmTools } from '../../../src/tools/confirm/register.js';

/**
 * The voucher write tools against a mock that behaves the way TallyPrime was
 * observed to on 2026-10-14 — including the dangerous part: an alter aimed at a
 * MasterID that no longer exists CREATES a new voucher instead of failing.
 */

const COMPANY = 'Test Books LLC';
const GUID_PREFIX = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const COMPANY_LIST = `<ENVELOPE><BODY><DATA><COLLECTION>
  <COMPANY NAME="${COMPANY}" RESERVEDNAME="">
    <STARTINGFROM TYPE="Date">20250401</STARTINGFROM>
    <ENDINGAT TYPE="Date">20260331</ENDINGAT>
    <NAME TYPE="String">${COMPANY}</NAME>
    <CURRENCYNAME TYPE="String">$</CURRENCYNAME>
  </COMPANY>
</COLLECTION></DATA></BODY></ENVELOPE>`;
const GROUPS = `<ENVELOPE><BODY><DATA><COLLECTION>
  <GROUP NAME="Indirect Expenses"><PARENT></PARENT></GROUP>
  <GROUP NAME="Sundry Creditors"><PARENT>Current Liabilities</PARENT></GROUP>
  <GROUP NAME="Bank Accounts"><PARENT>Current Assets</PARENT></GROUP>
</COLLECTION></DATA></BODY></ENVELOPE>`;
const LEDGERS = `<ENVELOPE><BODY><DATA><COLLECTION>
  <LEDGER NAME="Rent"><PARENT>Indirect Expenses</PARENT></LEDGER>
  <LEDGER NAME="Landlord"><PARENT>Sundry Creditors</PARENT></LEDGER>
  <LEDGER NAME="City Bank"><PARENT>Bank Accounts</PARENT></LEDGER>
</COLLECTION></DATA></BODY></ENVELOPE>`;
const TYPES = `<ENVELOPE><BODY><DATA><COLLECTION>
  <VOUCHERTYPE NAME="Journal"><PARENT>Journal</PARENT></VOUCHERTYPE>
  <VOUCHERTYPE NAME="Payment"><PARENT>Payment</PARENT></VOUCHERTYPE>
</COLLECTION></DATA></BODY></ENVELOPE>`;

interface FakeVoucher {
  masterId: number;
  alterId: number;
  type: string;
  date: string;
  number: string;
  narration: string;
  cancelled: boolean;
  lines: { ledger: string; amount: string }[];
}

let mock: MockTallyServer;
let port: number;
let book: FakeVoucher[];
let nextMasterId: number;
let registry: ToolRegistry;

const guidOf = (masterId: number): string => `${GUID_PREFIX}-${masterId.toString(16).padStart(8, '0')}`;

function voucherXml(): string {
  const rows = book.map((v) => {
    const lines = v.lines
      .map(
        (l) =>
          `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${l.ledger}</LEDGERNAME>` +
          `<ISDEEMEDPOSITIVE>${l.amount.startsWith('-') ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>` +
          `<AMOUNT>${l.amount}</AMOUNT></ALLLEDGERENTRIES.LIST>`
      )
      .join('');
    return (
      `<VOUCHER VCHTYPE="${v.type}"><GUID>${guidOf(v.masterId)}</GUID><DATE>${v.date}</DATE>` +
      `<VOUCHERTYPENAME>${v.type}</VOUCHERTYPENAME><VOUCHERNUMBER>${v.number}</VOUCHERNUMBER>` +
      `<NARRATION>${v.narration}</NARRATION><ISCANCELLED>${v.cancelled ? 'Yes' : 'No'}</ISCANCELLED>` +
      `<MASTERID>${String(v.masterId)}</MASTERID><ALTERID>${String(v.alterId)}</ALTERID>${lines}</VOUCHER>`
    );
  });
  return `<ENVELOPE><BODY><DATA><COLLECTION>${rows.join('')}</COLLECTION></DATA></BODY></ENVELOPE>`;
}

function linesOf(body: string): { ledger: string; amount: string }[] {
  return [...body.matchAll(/<LEDGERNAME>([^<]+)<\/LEDGERNAME>.*?<AMOUNT>([^<]+)<\/AMOUNT>/g)].map((m) => ({
    ledger: m[1] ?? '',
    amount: m[2] ?? '',
  }));
}

function reply(fields: Record<string, number>, lineError?: string): { body: string } {
  const counts = { CREATED: 0, ALTERED: 0, DELETED: 0, LASTVCHID: 0, LASTMID: 0, COMBINED: 0, IGNORED: 0, ERRORS: 0, CANCELLED: 0, EXCEPTIONS: 0, ...fields };
  return {
    body:
      '<RESPONSE>' +
      (lineError === undefined ? '' : `<LINEERROR>${lineError}</LINEERROR>`) +
      Object.entries(counts).map(([k, v]) => `<${k}>${String(v)}</${k}>`).join('') +
      '</RESPONSE>',
  };
}

/** TallyPrime's voucher import, as observed live. */
function applyVoucherImport(body: string): { body: string } {
  const action = /ACTION="(\w+)"/.exec(body)?.[1];
  const target = Number(/TAGVALUE="(\d+)"/.exec(body)?.[1] ?? NaN);
  const existing = book.find((v) => v.masterId === target);
  const date = /<DATE>(\d+)<\/DATE>/.exec(body)?.[1] ?? '';
  const create = (): { body: string } => {
    const masterId = nextMasterId++;
    book.push({
      masterId,
      alterId: 1,
      type: /<VOUCHERTYPENAME>([^<]+)/.exec(body)?.[1] ?? '',
      date,
      number: '1',
      narration: /<NARRATION>([^<]*)/.exec(body)?.[1] ?? '',
      cancelled: false,
      lines: linesOf(body),
    });
    return reply({ CREATED: 1, LASTVCHID: masterId });
  };

  if (action === 'Create') return create();
  if (action === 'Delete') {
    if (existing === undefined) return reply({ ERRORS: 1 }, 'Voucher does not exist!');
    book = book.filter((v) => v !== existing);
    return reply({ DELETED: 1, LASTVCHID: target });
  }
  // Alter and Cancel on a MasterID that does not exist: TallyPrime creates.
  if (existing === undefined) return create();
  existing.alterId += 1;
  if (action === 'Cancel') {
    existing.cancelled = true;
    existing.lines = [];
    existing.narration = /<NARRATION>([^<]*)/.exec(body)?.[1] ?? existing.narration;
  } else {
    existing.lines = linesOf(body);
    existing.narration = /<NARRATION>([^<]*)/.exec(body)?.[1] ?? existing.narration;
  }
  return reply({ ALTERED: 1, LASTVCHID: target });
}

function imports(): string[] {
  return mock.requests.map((r) => r.body).filter((b) => b.includes('<TALLYREQUEST>Import Data'));
}

const JOURNAL = {
  voucherType: 'Journal',
  date: '2025-09-01',
  narration: 'Rent provision',
  entries: [
    { ledger: 'Rent', side: 'Dr', amount: '1200' },
    { ledger: 'Landlord', side: 'Cr', amount: '1200' },
  ],
};

beforeAll(async () => {
  mock = new MockTallyServer();
  port = await mock.start();
});

afterAll(async () => {
  await mock.stop();
});

beforeEach(() => {
  book = [
    {
      masterId: 100,
      alterId: 5,
      type: 'Journal',
      date: '20250901',
      number: '7',
      narration: 'Existing',
      cancelled: false,
      lines: [
        { ledger: 'Rent', amount: '-500.00' },
        { ledger: 'Landlord', amount: '500.00' },
      ],
    },
  ];
  nextMasterId = 200;
  forgetEducationalMode();
  mock.reset();
  mock.onBodyContaining('<TALLYREQUEST>Import Data', (body) => applyVoucherImport(body));
  mock.onBodyContaining('List of Companies', { body: COMPANY_LIST });
  mock.onBodyContaining('<ID>Ledgers</ID>', { body: LEDGERS });
  mock.onBodyContaining('<ID>Groups</ID>', { body: GROUPS });
  mock.onBodyContaining('<ID>VoucherTypes</ID>', { body: TYPES });
  mock.onBodyContaining('<ID>AllVouchers</ID>', () => ({ body: voucherXml() }));

  registry = createToolRegistry();
  const deps = makeDeps(port, {
    TALLY_WRITE_LOG_PATH: join(mkdtempSync(join(tmpdir(), 'tally-vch-log-')), 'log.jsonl'),
  });
  registerCreateTools(registry.server, deps);
  registerAlterTools(registry.server, deps);
  registerCancelTools(registry.server, deps);
  registerDeleteTools(registry.server, deps);
  registerConfirmTools(registry.server, deps);
});

async function confirm(preview: Record<string, unknown>): Promise<Record<string, unknown>> {
  return callToolOk(registry, 'tally_confirm_write', { confirmToken: preview.confirmToken });
}

describe('tally_create_voucher', () => {
  it('posts a balanced journal with debits negative, and reads it back by MasterId', async () => {
    const preview = await callToolOk(registry, 'tally_create_voucher', JOURNAL);
    expect(preview.totalDebit).toBe('1200.00');
    expect(imports()).toEqual([]);

    const result = await confirm(preview);
    expect(result.status).toMatch(/^WRITTEN and confirmed/);
    expect(imports()[0]).toContain('<LEDGERNAME>Rent</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1200</AMOUNT>');
    expect(imports()[0]).toContain('<DATE>20250901</DATE>');
    expect((result.readBack as Record<string, unknown>).masterId).toBe(200);
  });

  it('sends the party line first, because TallyPrime takes the party from the first line', async () => {
    const preview = await callToolOk(registry, 'tally_create_voucher', {
      voucherType: 'Payment',
      date: '2025-09-01',
      partyLedger: 'Landlord',
      entries: [
        { ledger: 'City Bank', side: 'Cr', amount: '50' },
        { ledger: 'Landlord', side: 'Dr', amount: '50' },
      ],
    });
    expect((preview.lines as { ledger: string }[])[0]?.ledger).toBe('Landlord');

    await callToolOk(registry, 'tally_confirm_write', { confirmToken: preview.confirmToken });
    const sent = imports()[0] ?? '';
    expect(sent.indexOf('<LEDGERNAME>Landlord')).toBeLessThan(sent.indexOf('<LEDGERNAME>City Bank'));
  });

  it('refuses an unbalanced voucher before anything is prepared', async () => {
    const error = await callToolError(registry, 'tally_create_voucher', {
      ...JOURNAL,
      entries: [
        { ledger: 'Rent', side: 'Dr', amount: '1200' },
        { ledger: 'Landlord', side: 'Cr', amount: '1100' },
      ],
    });
    expect(error.code).toBe('INVALID_PARAMETERS');
    expect(error.message).toMatch(/difference is 100\.00/);
  });

  it('refuses a ledger that does not exist', async () => {
    const error = await callToolError(registry, 'tally_create_voucher', {
      ...JOURNAL,
      entries: [
        { ledger: 'Rentt', side: 'Dr', amount: '1' },
        { ledger: 'Landlord', side: 'Cr', amount: '1' },
      ],
    });
    expect(error.code).toBe('INVALID_PARAMETERS');
  });

  it('refuses a date before the books begin', async () => {
    const error = await callToolError(registry, 'tally_create_voucher', { ...JOURNAL, date: '2024-01-01' });
    expect(error.message).toMatch(/before the books/);
  });

  it('after an Educational-mode date rejection, warns of the hidden trace and refuses other days', async () => {
    const preview = await callToolOk(registry, 'tally_create_voucher', { ...JOURNAL, date: '2025-09-15' });
    mock.onBodyContaining('<TALLYREQUEST>Import Data', reply({ EXCEPTIONS: 1 }, 'Voucher date is missing'));
    const error = await callToolError(registry, 'tally_confirm_write', { confirmToken: preview.confirmToken });
    expect(error.code).toBe('WRITE_REJECTED');
    expect(error.message).toMatch(/hidden trace/);

    const sentBefore = imports().length;
    const refused = await callToolError(registry, 'tally_create_voucher', { ...JOURNAL, date: '2025-09-16' });
    expect(refused.message).toMatch(/Educational mode/);
    expect(imports().length).toBe(sentBefore);
    await callToolOk(registry, 'tally_create_voucher', { ...JOURNAL, date: '2025-08-31' });
  });

  it('warns about a payment that touches no bank or cash ledger', async () => {
    const preview = await callToolOk(registry, 'tally_create_voucher', { ...JOURNAL, voucherType: 'Payment' });
    expect(JSON.stringify(preview.warnings)).toMatch(/cash or bank/);
  });

  it('warns about an identical voucher already on that date', async () => {
    const preview = await callToolOk(registry, 'tally_create_voucher', {
      ...JOURNAL,
      entries: [
        { ledger: 'Rent', side: 'Dr', amount: '500' },
        { ledger: 'Landlord', side: 'Cr', amount: '500' },
      ],
    });
    expect(JSON.stringify(preview.warnings)).toMatch(/POSSIBLE DUPLICATE/);
  });

  it('refuses bill allocations that do not add up to the line', async () => {
    const error = await callToolError(registry, 'tally_create_voucher', {
      ...JOURNAL,
      entries: [
        { ledger: 'Rent', side: 'Dr', amount: '1200' },
        { ledger: 'Landlord', side: 'Cr', amount: '1200', bills: [{ type: 'New Ref', reference: 'INV-1', amount: '1000' }] },
      ],
    });
    expect(error.message).toMatch(/bills on "Landlord" add up to 1000\.00/);
  });
});

describe('tally_alter_voucher', () => {
  const target = { guid: guidOf(100), currentDate: '2025-09-01' };

  it('replaces the voucher by MasterID and shows before and after', async () => {
    const preview = await callToolOk(registry, 'tally_alter_voucher', { ...target, ...JOURNAL });
    expect(preview.before).toMatchObject({ voucherNumber: '7' });

    const result = await confirm(preview);
    expect(result.status).toMatch(/^WRITTEN and confirmed/);
    expect(imports()[0]).toContain('TAGNAME="MasterID" TAGVALUE="100"');
    expect(imports()[0]).toContain('<VOUCHERNUMBER>7</VOUCHERNUMBER>');
    expect(book).toHaveLength(1);
  });

  it('refuses at confirm when the voucher was deleted meanwhile — Tally would create one instead', async () => {
    const preview = await callToolOk(registry, 'tally_alter_voucher', { ...target, ...JOURNAL });
    book = [];

    const error = await callToolError(registry, 'tally_confirm_write', { confirmToken: preview.confirmToken });
    expect(error.code).toBe('WRITE_CONFLICT');
    expect(imports()).toEqual([]);
  });

  it('refuses at confirm when the voucher was altered meanwhile', async () => {
    const preview = await callToolOk(registry, 'tally_alter_voucher', { ...target, ...JOURNAL });
    const existing = book[0];
    if (existing !== undefined) existing.alterId += 1;

    const error = await callToolError(registry, 'tally_confirm_write', { confirmToken: preview.confirmToken });
    expect(error.code).toBe('WRITE_CONFLICT');
  });

  it('refuses to change the voucher type', async () => {
    const error = await callToolError(registry, 'tally_alter_voucher', { ...target, ...JOURNAL, voucherType: 'Payment' });
    expect(error.message).toMatch(/changing its type is not an alter/);
  });
});

describe('tally_cancel_voucher and tally_delete_voucher', () => {
  const target = { guid: guidOf(100), currentDate: '2025-09-01' };

  it('cancels, judging success on ALTERED as TallyPrime reports it', async () => {
    const preview = await callToolOk(registry, 'tally_cancel_voucher', { ...target, reason: 'Posted twice' });
    const result = await confirm(preview);

    expect(result.status).toMatch(/^WRITTEN and confirmed/);
    expect(imports()[0]).toContain('ACTION="Cancel"');
    expect(book[0]?.cancelled).toBe(true);
  });

  it('refuses to cancel a voucher that is already cancelled', async () => {
    const existing = book[0];
    if (existing !== undefined) existing.cancelled = true;
    const error = await callToolError(registry, 'tally_cancel_voucher', { ...target, reason: 'again' });
    expect(error.message).toMatch(/already cancelled/);
  });

  it('deletes and confirms the voucher is gone', async () => {
    const preview = await callToolOk(registry, 'tally_delete_voucher', target);
    const result = await confirm(preview);
    expect(result.status).toMatch(/^WRITTEN and confirmed/);
    expect(book).toEqual([]);
  });

  it('refuses a guid that is not on the given date', async () => {
    const error = await callToolError(registry, 'tally_delete_voucher', { ...target, currentDate: '2025-09-02' });
    expect(error.code).toBe('INVALID_PARAMETERS');
  });
});
