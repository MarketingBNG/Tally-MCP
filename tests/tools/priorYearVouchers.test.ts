import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolOk,
  createToolRegistry,
  makeDeps,
  type ToolRegistry,
} from './harness.js';
import { registerVoucherTools } from '../../src/tools/vouchers.js';

/**
 * Vouchers from a PRIOR financial year.
 *
 * ## What was broken
 *
 * A Voucher collection is pinned to the company's current financial year and
 * cannot be moved off it — `SVFROMDATE`/`SVTODATE`, `SVCURRENTDATE` and
 * `SVCURRENTPERIOD` were each measured live against MUDALS and every one
 * returned the same current-year vouchers, byte for byte. So a request for
 * FY2023-24 fetched FY2026-27, the local period filter discarded all of it, and
 * the caller got an empty list with `truncated: false`. Five years of a real
 * book were unreachable, and to an auditor it read as "that year had no
 * transactions".
 *
 * ## What fixes it
 *
 * `Voucher Register` is a report, and reports honour the date range. It carries
 * full ledger entries, parses with the same normaliser, and was verified to
 * agree with the collection over a common period — 284 vouchers, 985 entries,
 * identical GUIDs, same total to the paisa.
 *
 * Live result after the change, against MUDALS: FY2023-24 returns 14 vouchers
 * where it returned 0, and a two-year span returns 802 — exactly 14 + 788 from
 * the per-year probe, so nothing is dropped or double-counted.
 *
 * ## What these tests are mostly about
 *
 * Cost and honesty rather than plumbing. The report is ~50x the collection's
 * payload (measured: 39MB and 79MB for single years, and a five-year request
 * timed out), so the current year must NOT be routed to it. And because a year
 * can fail on its own, the population can be incomplete — which must be said,
 * never silently returned as though it were whole.
 */

let mock: MockTallyServer;
let port: number;

/** Books start 1 April and run to July 2026, so the current year is FY2026-27. */
const COMPANY = 'EXAMPLE TRADING PRIVATE LIMITED';
const COMPANY_LIST = `<ENVELOPE><BODY><DATA><COLLECTION>
  <COMPANY NAME="${COMPANY}" RESERVEDNAME="">
    <STARTINGFROM TYPE="Date">20210401</STARTINGFROM>
    <ENDINGAT TYPE="Date">20260728</ENDINGAT>
    <NAME TYPE="String">${COMPANY}</NAME>
    <CURRENCYNAME TYPE="String">Rs.</CURRENCYNAME>
    <COUNTRYNAME TYPE="String">India</COUNTRYNAME>
  </COMPANY>
</COLLECTION></DATA></BODY></ENVELOPE>`;

/** One voucher, with a balanced pair of entries so it parses as real. */
function voucher(guid: string, date: string, number: string, amount: string): string {
  return [
    `<VOUCHER VCHTYPE="Payment" ACTION="Create">`,
    `<DATE>${date}</DATE>`,
    `<GUID>${guid}</GUID>`,
    `<VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>`,
    `<VOUCHERNUMBER>${number}</VOUCHERNUMBER>`,
    `<PARTYLEDGERNAME>Acme Supplies</PARTYLEDGERNAME>`,
    `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Acme Supplies</LEDGERNAME>`,
    `<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${amount}</AMOUNT></ALLLEDGERENTRIES.LIST>`,
    `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Bank</LEDGERNAME>`,
    `<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${amount}</AMOUNT></ALLLEDGERENTRIES.LIST>`,
    `</VOUCHER>`,
  ].join('');
}

function envelope(...vouchers: string[]): string {
  return `<ENVELOPE><BODY><DATA><COLLECTION>${vouchers.join('')}</COLLECTION></DATA></BODY></ENVELOPE>`;
}

function build(): ToolRegistry {
  const registry = createToolRegistry();
  registerVoucherTools(registry.server, makeDeps(port, { TALLY_CACHE_TTL_MS: '0' }));
  return registry;
}

/** Requests that went out as the Voucher Register report. */
function registerRequests(): string[] {
  return mock.requests
    .map((request) => request.body)
    .filter((body) => body.includes('<ID>Voucher Register</ID>'));
}

/** Requests that went out as the voucher collection. */
function collectionRequests(): string[] {
  return mock.requests
    .map((request) => request.body)
    .filter((body) => body.includes('<ID>AllVouchers</ID>'));
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
  mock.onBodyContaining('List of Companies', { body: COMPANY_LIST });
  mock.onBodyContaining('<ID>Currencies</ID>', {
    body: '<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>',
  });
  // The collection always answers with the CURRENT year, whatever it is asked
  // for — which is the TallyPrime behaviour that made prior years unreachable.
  mock.onBodyContaining('<ID>AllVouchers</ID>', {
    body: envelope(voucher('cur-1', '20260610', 'P-100', '5000.00')),
  });
});

describe('a prior year is read from the Voucher Register', () => {
  beforeEach(() => {
    mock.onBodyContaining('<SVFROMDATE>20230401</SVFROMDATE>', {
      body: envelope(
        voucher('fy24-1', '20230715', 'P-1', '1000.00'),
        voucher('fy24-2', '20231120', 'P-2', '2000.00')
      ),
    });
  });

  it('returns vouchers that the collection could never have reached', async () => {
    const result = await callToolOk(build(), 'tally_get_vouchers', {
      company: COMPANY,
      fromDate: '2023-04-01',
      toDate: '2024-03-31',
      pageSize: 50,
    });

    const items = result.items as { voucherNumber: string }[];
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.voucherNumber).sort()).toEqual(['P-1', 'P-2']);
  });

  it('asks the report for that year, scoped to the company', async () => {
    await callToolOk(build(), 'tally_get_vouchers', {
      company: COMPANY,
      fromDate: '2023-04-01',
      toDate: '2024-03-31',
      pageSize: 50,
    });

    const sent = registerRequests();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('<SVFROMDATE>20230401</SVFROMDATE>');
    expect(sent[0]).toContain('<SVTODATE>20240331</SVTODATE>');
    expect(sent[0]).toContain(`<SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY>`);
  });

  it('says the figures came from a different source', async () => {
    // An auditor comparing years needs to know two sources are in play, and
    // that they were checked against each other.
    const result = await callToolOk(build(), 'tally_get_vouchers', {
      company: COMPANY,
      fromDate: '2023-04-01',
      toDate: '2024-03-31',
      pageSize: 50,
    });

    const warnings = (result.warnings as string[]).join(' ');
    expect(warnings).toContain('PRIOR YEARS INCLUDED');
    expect(warnings).toContain('Voucher Register');
    // Reads as one year, not as "1 book year, one of which".
    expect(warnings).toContain('lies in a book year outside');
  });
});

describe('the current year keeps using the collection', () => {
  it('never sends the register for a current-year period', async () => {
    // The report is ~50x the payload for identical data. Routing the common
    // case to it would be a large regression that fixes nothing.
    const result = await callToolOk(build(), 'tally_get_vouchers', {
      company: COMPANY,
      fromDate: '2026-04-01',
      toDate: '2027-03-31',
      pageSize: 50,
    });

    expect(registerRequests()).toHaveLength(0);
    expect(collectionRequests()).toHaveLength(1);
    expect(result.items).toHaveLength(1);
  });

  it('says nothing about prior years when none were involved', async () => {
    const result = await callToolOk(build(), 'tally_get_vouchers', {
      company: COMPANY,
      fromDate: '2026-04-01',
      toDate: '2027-03-31',
      pageSize: 50,
    });

    expect((result.warnings as string[]).join(' ')).not.toContain('PRIOR YEARS INCLUDED');
  });
});

describe('a span across several book years', () => {
  beforeEach(() => {
    mock.onBodyContaining('<SVFROMDATE>20230401</SVFROMDATE>', {
      body: envelope(voucher('fy24-1', '20230715', 'P-1', '1000.00')),
    });
    mock.onBodyContaining('<SVFROMDATE>20240401</SVFROMDATE>', {
      body: envelope(
        voucher('fy25-1', '20240815', 'P-3', '3000.00'),
        voucher('fy25-2', '20250210', 'P-4', '4000.00')
      ),
    });
  });

  it('fetches one request per year and merges them', async () => {
    const result = await callToolOk(build(), 'tally_get_vouchers', {
      company: COMPANY,
      fromDate: '2023-04-01',
      toDate: '2025-03-31',
      pageSize: 50,
    });

    expect(registerRequests()).toHaveLength(2);
    const items = result.items as { voucherNumber: string }[];
    expect(items.map((item) => item.voucherNumber).sort()).toEqual(['P-1', 'P-3', 'P-4']);
  });

  it('counts the years in the disclosure, using the plural', async () => {
    const result = await callToolOk(build(), 'tally_get_vouchers', {
      company: COMPANY,
      fromDate: '2023-04-01',
      toDate: '2025-03-31',
      pageSize: 50,
    });

    expect((result.warnings as string[]).join(' ')).toContain('spans 2 book years, 2 of them outside');
  });
});

describe('a year that fails is reported, never hidden', () => {
  beforeEach(() => {
    mock.onBodyContaining('<SVFROMDATE>20230401</SVFROMDATE>', {
      body: envelope(voucher('fy24-1', '20230715', 'P-1', '1000.00')),
    });
    // The second year fails outright — the shape a timeout takes on a 79MB year.
    mock.onBodyContaining('<SVFROMDATE>20240401</SVFROMDATE>', { status: 500 });
  });

  it('still returns the years that succeeded', async () => {
    // Losing good data because one year failed would be its own harm.
    const result = await callToolOk(build(), 'tally_get_vouchers', {
      company: COMPANY,
      fromDate: '2023-04-01',
      toDate: '2025-03-31',
      pageSize: 50,
    });

    expect(result.items).toHaveLength(1);
  });

  it('says the population is incomplete and which year is missing', async () => {
    // THE LOAD-BEARING TEST. A short population presented as whole is how a
    // wrong total reaches a workpaper.
    const result = await callToolOk(build(), 'tally_get_vouchers', {
      company: COMPANY,
      fromDate: '2023-04-01',
      toDate: '2025-03-31',
      pageSize: 50,
    });

    const warnings = (result.warnings as string[]).join(' ');
    expect(warnings).toContain('INCOMPLETE POPULATION');
    expect(warnings).toContain('2024-04-01..2025-03-31');
    expect(warnings).toContain('understated');
  });
});
