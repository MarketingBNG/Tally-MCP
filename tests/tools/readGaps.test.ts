import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolOk,
  createToolRegistry,
  makeDeps,
  type ToolRegistry,
} from './harness.js';
import { registerMasterTools } from '../../src/tools/read/masters.js';
import { registerVoucherTools } from '../../src/tools/read/vouchers/register.js';

/**
 * Reads added after the write tools showed they were missing: the simple master
 * lists in tally_get_masters, a ledger's contact details, and the voucher
 * status filter. Live-checked on four companies 2026-10-14; pinned here.
 */

const COMPANY = 'Test Books LLC';
const COMPANY_LIST = `<ENVELOPE><BODY><DATA><COLLECTION>
  <COMPANY NAME="${COMPANY}"><STARTINGFROM>20250401</STARTINGFROM><ENDINGAT>20260331</ENDINGAT>
  <NAME>${COMPANY}</NAME><CURRENCYNAME>$</CURRENCYNAME></COMPANY>
</COLLECTION></DATA></BODY></ENVELOPE>`;
const GODOWNS = `<ENVELOPE><BODY><DATA><COLLECTION>
  <GODOWN NAME="Main Location"><PARENT>Primary</PARENT><ALTERID>12</ALTERID></GODOWN>
  <GODOWN NAME="Bay 2"><PARENT>Main Location</PARENT></GODOWN>
</COLLECTION></DATA></BODY></ENVELOPE>`;
const LEDGERS = `<ENVELOPE><BODY><DATA><COLLECTION>
  <LEDGER NAME="Acme Corp"><PARENT>Sundry Debtors</PARENT><EMAIL>ap@acme.test</EMAIL><ISBILLWISEON>Yes</ISBILLWISEON>
    <LEDMAILINGDETAILS.LIST><ADDRESS.LIST TYPE="String"><ADDRESS>1 Main St</ADDRESS><ADDRESS>Suite 2</ADDRESS></ADDRESS.LIST>
    <APPLICABLEFROM>20250401</APPLICABLEFROM><PINCODE>48226</PINCODE><MAILINGNAME>Acme Corporation</MAILINGNAME>
    <STATE>Michigan</STATE><CITY/><COUNTRY>United States of America</COUNTRY></LEDMAILINGDETAILS.LIST>
  </LEDGER>
</COLLECTION></DATA></BODY></ENVELOPE>`;

function voucher(n: number, flags: { cancelled?: boolean; optional?: boolean } = {}): string {
  return (
    `<VOUCHER VCHTYPE="Journal"><GUID>g-${String(n)}</GUID><DATE>20250501</DATE><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>` +
    `<VOUCHERNUMBER>${String(n)}</VOUCHERNUMBER><ISCANCELLED>${flags.cancelled ? 'Yes' : 'No'}</ISCANCELLED>` +
    `<ISOPTIONAL>${flags.optional ? 'Yes' : 'No'}</ISOPTIONAL>` +
    '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Rent</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-10.00</AMOUNT></ALLLEDGERENTRIES.LIST>' +
    '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>10.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>'
  );
}
const VOUCHERS = `<ENVELOPE><BODY><DATA><COLLECTION>${voucher(1)}${voucher(2, { cancelled: true })}${voucher(3, { optional: true })}</COLLECTION></DATA></BODY></ENVELOPE>`;

let mock: MockTallyServer;
let port: number;
let registry: ToolRegistry;

beforeAll(async () => {
  mock = new MockTallyServer();
  port = await mock.start();
});

afterAll(async () => {
  await mock.stop();
});

beforeEach(() => {
  mock.reset();
  mock.onBodyContaining('TallyMcpCompanies', { body: COMPANY_LIST });
  mock.onBodyContaining('<ID>GodownMasters</ID>', { body: GODOWNS });
  mock.onBodyContaining('<ID>Ledgers</ID>', { body: LEDGERS });
  mock.onBodyContaining('<ID>AllVouchers</ID>', { body: VOUCHERS });
  registry = createToolRegistry();
  const deps = makeDeps(port);
  registerMasterTools(registry.server, deps);
  registerVoucherTools(registry.server, deps);
});

describe('tally_get_masters — simple lists', () => {
  it('lists godowns with their parent and every recorded field', async () => {
    const result = await callToolOk(registry, 'tally_get_masters', { type: 'godown' });
    const items = result.items as { name: string; parent: string }[];
    expect(items.map((g) => g.name)).toEqual(['Main Location', 'Bay 2']);
    expect(items[1]?.parent).toBe('Main Location');
  });

  it('fetches one by name', async () => {
    const result = await callToolOk(registry, 'tally_get_masters', { type: 'godown', name: 'bay 2' });
    expect((result.godown as { name: string }).name).toBe('Bay 2');
  });
});

describe('tally_get_masters — ledger contact details', () => {
  it('returns the address from the dated mailing block on a named lookup', async () => {
    const result = await callToolOk(registry, 'tally_get_masters', { type: 'ledger', name: 'Acme Corp' });
    expect(result.contactDetails).toMatchObject({
      email: 'ap@acme.test',
      isBillWiseOn: true,
      mailing: [
        {
          mailingName: 'Acme Corporation',
          address: ['1 Main St', 'Suite 2'],
          state: 'Michigan',
          pincode: '48226',
          country: 'United States of America',
        },
      ],
    });
  });
});

describe('tally_get_vouchers — status filter', () => {
  const period = { fromDate: '2025-04-01', toDate: '2026-03-31' };
  const numbersFor = async (status?: string): Promise<string[]> => {
    const result = await callToolOk(registry, 'tally_get_vouchers', { ...period, ...(status ? { status } : {}) });
    return (result.items as { voucherNumber: string }[]).map((v) => v.voucherNumber);
  };

  it('separates regular, cancelled and optional', async () => {
    expect(await numbersFor('regular')).toEqual(['1']);
    expect(await numbersFor('cancelled')).toEqual(['2']);
    expect(await numbersFor('optional')).toEqual(['3']);
  });

  it('returns every status when omitted, as before', async () => {
    expect((await numbersFor()).sort()).toEqual(['1', '2', '3']);
  });
});
