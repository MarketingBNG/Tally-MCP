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
import { registerVoucherTestTools } from '../../src/tools/testVouchers.js';

/**
 * `tally_test_vouchers` test "late_entry": when a voucher was last WRITTEN.
 *
 * The behaviour under test that matters most is the REFUSAL. TallyPrime sends
 * `UPDATEDDATETIME` as an all-zero placeholder on a company that does not stamp
 * its vouchers — it does not omit the field. So the natural implementation of
 * this test returns an empty candidate list on such a company, which reads as
 * "no entries were written late" when the truth is "nothing could be examined".
 * An auditor acting on that has been told the opposite of the facts.
 *
 * Verified against a live TallyPrime on 2026-08-18: two companies stamped every
 * voucher, a third stamped none. See docs/probe-findings-2026-08-18.md.
 */

let mock: MockTallyServer;
let port: number;

function build(): ToolRegistry {
  const registry = createToolRegistry();
  registerVoucherTestTools(registry.server, makeDeps(port));
  return registry;
}

/**
 * Vouchers with write timestamps under our control.
 *
 * Hand-built rather than a redacted capture, because the point is the
 * relationship between two dates and no real export happens to hold the exact
 * cases needed — a voucher written the same day, one written well after, one
 * written after the period closed, one post-dated, one carrying the placeholder.
 */
function vouchersXml(rows: { number: string; date: string; written: string }[]): string {
  const blocks = rows
    .map(
      (row) =>
        `<VOUCHER VCHTYPE="Sales" ACTION="Create">` +
        `<DATE>${row.date}</DATE>` +
        `<GUID>guid-${row.number}</GUID>` +
        `<VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>` +
        `<VOUCHERNUMBER>${row.number}</VOUCHERNUMBER>` +
        `<PARTYLEDGERNAME>Northwind Retail Limited</PARTYLEDGERNAME>` +
        `<ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL>` +
        `<UPDATEDDATETIME TYPE="DateTime">${row.written}</UPDATEDDATETIME>` +
        `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Northwind Retail Limited</LEDGERNAME>` +
        `<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1000.00</AMOUNT>` +
        `</ALLLEDGERENTRIES.LIST>` +
        `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME>` +
        `<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1000.00</AMOUNT>` +
        `</ALLLEDGERENTRIES.LIST>` +
        `</VOUCHER>`
    )
    .join('');
  return (
    `<ENVELOPE><BODY><DESC><CMPINFO><VOUCHER>0</VOUCHER></CMPINFO></DESC>` +
    `<DATA><TALLYMESSAGE>${blocks}</TALLYMESSAGE></DATA></BODY></ENVELOPE>`
  );
}

const PERIOD = { fromDate: '2021-04-01', toDate: '2022-03-31' };

/** The all-zero placeholder, exactly as a live unstamped company returns it. */
const NEVER_STAMPED = '000000000';

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
});

function serveVouchers(rows: { number: string; date: string; written: string }[]): void {
  mock.onBodyContaining('<TYPE>Voucher</TYPE>', { body: vouchersXml(rows) });
}

describe('late_entry refuses rather than reporting a clean result', () => {
  it('fails with TALLY_UNSUPPORTED_OPERATION when no voucher carries a timestamp', async () => {
    serveVouchers([
      { number: '1', date: '20210715', written: NEVER_STAMPED },
      { number: '2', date: '20210820', written: NEVER_STAMPED },
    ]);

    const error = await callToolError(build(), 'tally_test_vouchers', {
      test: 'late_entry',
      ...PERIOD,
    });

    expect(error.code).toBe('TALLY_UNSUPPORTED_OPERATION');
    // The message has to deny the reading an empty result would invite.
    expect(error.message).toContain('NOT');
    expect(error.message).toContain('no late entries');
    expect(error.suggestion).toContain('Edit Log');
  });

  it('counts the unstamped vouchers it could not test rather than passing over them', async () => {
    serveVouchers([
      { number: '1', date: '20210715', written: '20210715104500000' },
      { number: '2', date: '20210820', written: NEVER_STAMPED },
      { number: '3', date: '20210901', written: NEVER_STAMPED },
    ]);

    const result = await callToolOk(build(), 'tally_test_vouchers', {
      test: 'late_entry',
      ...PERIOD,
    });

    expect(result.timestampCoverage).toEqual({ stamped: 1, unstamped: 2, undated: 0 });
    const warnings = (result.warnings as string[]).join(' ');
    expect(warnings).toContain('2 of 3 voucher(s) carry NO write timestamp');
    expect(warnings).toContain('were never examined');
  });
});

describe('late_entry flags on lag and on writing after the period end', () => {
  it('flags a voucher written after the period closed whatever the threshold', async () => {
    serveVouchers([
      // Dated inside the year, written five weeks after it ended.
      { number: '1', date: '20220330', written: '20220505091500000' },
    ]);

    const result = await callToolOk(build(), 'tally_test_vouchers', {
      test: 'late_entry',
      ...PERIOD,
      // Deliberately far above the 36-day lag: the after-period-end reason must
      // stand on its own, since that case needs no threshold to be meaningful.
      lateEntryMinLagDays: 999,
    });

    expect(result.writtenAfterPeriodEnd).toBe(1);
    const candidates = result.candidates as { voucherNumber: string; reasons: string[] }[];
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.reasons.join(' ')).toContain('after the period closed');
  });

  it('does not flag a voucher written the same day it is dated', async () => {
    serveVouchers([{ number: '1', date: '20210715', written: '20210715104500000' }]);

    const result = await callToolOk(build(), 'tally_test_vouchers', {
      test: 'late_entry',
      ...PERIOD,
      lateEntryMinLagDays: 1,
    });

    expect(result.candidates).toEqual([]);
    expect(result.lagDistribution).toEqual({ minDays: 0, medianDays: 0, maxDays: 0 });
  });

  it('reports the lag distribution over the whole population, not just the flagged rows', async () => {
    serveVouchers([
      { number: '1', date: '20210701', written: '20210701090000000' }, // lag 0
      { number: '2', date: '20210701', written: '20210711090000000' }, // lag 10
      { number: '3', date: '20210701', written: '20210901090000000' }, // lag 62
    ]);

    const result = await callToolOk(build(), 'tally_test_vouchers', {
      test: 'late_entry',
      ...PERIOD,
      lateEntryMinLagDays: 30,
    });

    // One flagged, but the distribution describes all three — which is what lets
    // a reader judge whether 30 days is a sensible threshold for this company.
    expect(result.candidates).toHaveLength(1);
    expect(result.lagDistribution).toEqual({ minDays: 0, medianDays: 10, maxDays: 62 });
  });

  it('orders candidates by lag, largest first', async () => {
    serveVouchers([
      { number: 'small', date: '20210701', written: '20210805090000000' }, // 35
      { number: 'large', date: '20210701', written: '20211201090000000' }, // 153
      { number: 'middle', date: '20210701', written: '20210915090000000' }, // 76
    ]);

    const result = await callToolOk(build(), 'tally_test_vouchers', {
      test: 'late_entry',
      ...PERIOD,
      lateEntryMinLagDays: 30,
    });

    const numbers = (result.candidates as { voucherNumber: string }[]).map((c) => c.voucherNumber);
    expect(numbers).toEqual(['large', 'middle', 'small']);
  });

  it('counts a post-dated voucher instead of flagging it', async () => {
    // Written in June, dated for July — ordinary bookkeeping, not a candidate.
    serveVouchers([{ number: '1', date: '20210715', written: '20210620090000000' }]);

    const result = await callToolOk(build(), 'tally_test_vouchers', {
      test: 'late_entry',
      ...PERIOD,
      lateEntryMinLagDays: 1,
    });

    expect(result.postDated).toBe(1);
    expect(result.candidates).toEqual([]);
    expect((result.warnings as string[]).join(' ')).toContain('written BEFORE the date they carry');
  });
});

describe('late_entry says what it is not', () => {
  it('states per run that this is the last write, of unknown authorship', async () => {
    serveVouchers([{ number: '1', date: '20210701', written: '20211201090000000' }]);

    const result = await callToolOk(build(), 'tally_test_vouchers', {
      test: 'late_entry',
      ...PERIOD,
    });

    const warnings = (result.warnings as string[]).join(' ');
    expect(warnings).toContain('THIS IS THE LAST WRITE, NOT THE ENTRY');
    expect(warnings).toContain('NOT AN AUDIT TRAIL');
    expect(warnings).toContain('CARO Rule 11(g)');
    expect(warnings).toContain('A LAG IS NOT AN IRREGULARITY');
    // And per candidate, because a warnings array can be dropped by a summary
    // while the candidate rows are quoted into a workpaper.
    const candidates = result.candidates as { reasons: string[] }[];
    expect(candidates[0]?.reasons.join(' ')).toContain('LAST write, of unknown authorship');
  });

  it('describes the limits in the tool description, where the tool is chosen', () => {
    const description = build().descriptions.get('tally_test_vouchers') ?? '';
    expect(description).toContain('late_entry');
    expect(description).toContain('NOT an Edit Log');
    expect(description).toContain('CARO Rule 11(g)');
    expect(description).toContain('TALLY_UNSUPPORTED_OPERATION');
  });
});
