import { describe, it, expect } from 'vitest';
import { describeVoucherReachShortfall } from '../../src/tools/vouchers.js';
import type { Voucher } from '../../src/tally/normalize.js';

/**
 * The bug these cover, measured live on 2026-08-14:
 *
 * A voucher collection is scoped by TallyPrime to the CURRENT financial year
 * whatever dates are requested. On a company with books from 2021-04-01, a
 * request for FY 2023-24 came back with 285 vouchers dated 2026-04 to 2026-07.
 * The local period filter then discarded all of them, and the caller received an
 * empty list carrying `hasMore: false`, `truncated: false` and
 * `allGroupsNetToZero: true` — every completeness signal asserting there was
 * nothing to find, for five years of transactions that demonstrably exist.
 *
 * The hard part is not detecting it but detecting it WITHOUT crying wolf. A
 * warning that fires on ordinary sparse data would be skipped, and then the real
 * one is skipped with it. So the rule requires evidence that Tally ignored the
 * requested range, and stays silent when it has none — under-reporting rather
 * than guessing. Both halves are tested here; the silent cases matter as much as
 * the loud ones.
 */

function voucherOn(date: string | null): Voucher {
  // Only `date` is read by the function under test; the rest is structural.
  return { date, lines: [], fields: {} } as unknown as Voucher;
}

describe('describeVoucherReachShortfall', () => {
  it('refuses to let a wholly unreachable period read as "no transactions"', () => {
    // The exact live case: FY 2023-24 asked for, current-year vouchers returned.
    // Nothing overlaps, so the caller's empty list has nothing to do with their
    // question — the single most dangerous shape this can take.
    const warning = describeVoucherReachShortfall(
      [voucherOn('2026-04-01'), voucherOn('2026-07-28')],
      { fromDate: '2023-04-01', toDate: '2024-03-31' }
    );

    expect(warning).not.toBeNull();
    expect(warning).toContain('INCOMPLETE PERIOD');
    expect(warning).toContain('2023-04-01 to 2024-03-31');
    expect(warning).toContain('2026-04-01 to 2026-07-28');
    // The load-bearing sentence: an empty total must not be reported as absence.
    expect(warning).toContain('NONE of the period');
    expect(warning).toContain('NOT because no such transactions exist');
  });

  it('reports a partial overlap when Tally demonstrably ignored the range', () => {
    // 2026-07-28 arrived despite falling outside the requested window, which
    // proves the range was ignored. The span is therefore Tally's choice, so the
    // earlier part of the request is unreachable rather than empty.
    const warning = describeVoucherReachShortfall(
      [voucherOn('2026-04-01'), voucherOn('2026-07-28')],
      { fromDate: '2025-04-01', toDate: '2026-06-30' }
    );

    expect(warning).toContain('Only the overlapping part');
    // Some of the answer is real, so claiming nothing was read would be its own
    // error in the opposite direction.
    expect(warning).not.toContain('NONE of the period');
  });

  it('stays silent when the request is fully inside what came back', () => {
    // Tally sent the whole current year for a one-month question. The range was
    // ignored, but nothing the caller asked for is missing, so there is no
    // shortfall to report.
    expect(
      describeVoucherReachShortfall(
        [voucherOn('2026-04-01'), voucherOn('2026-05-15'), voucherOn('2026-07-28')],
        { fromDate: '2026-05-01', toDate: '2026-05-31' }
      )
    ).toBeNull();
  });

  it('stays silent on sparse data rather than crying wolf', () => {
    // A first transaction on 5 April for a period starting 1 April is ordinary.
    // Nothing arrived outside the window, so there is no evidence the range was
    // ignored — and a warning here would fire on nearly every real query.
    expect(
      describeVoucherReachShortfall([voucherOn('2026-04-05'), voucherOn('2026-07-20')], {
        fromDate: '2026-04-01',
        toDate: '2026-07-31',
      })
    ).toBeNull();
  });

  it('stays silent when the period runs into the future', () => {
    // Asking to the financial year end in August and receiving nothing dated
    // after July is not a shortfall — those months have not happened yet.
    expect(
      describeVoucherReachShortfall([voucherOn('2026-04-01'), voucherOn('2026-07-28')], {
        fromDate: '2026-04-01',
        toDate: '2027-03-31',
      })
    ).toBeNull();
  });

  it('under-reports rather than guesses when the request contains the whole span', () => {
    // Documented residual gap: nothing arrived outside the window, so this is
    // indistinguishable from a company with no transactions in the earlier year.
    // Becomes detectable once the company's financial-year start is available
    // (the A1 fix), because the truncation always starts on a year boundary.
    expect(
      describeVoucherReachShortfall([voucherOn('2026-04-01'), voucherOn('2026-07-28')], {
        fromDate: '2025-04-01',
        toDate: '2026-07-31',
      })
    ).toBeNull();
  });

  it('stays silent when no voucher carries a readable date', () => {
    // No span means no evidence of a shortfall. Warning on nothing would be a
    // claim the response does not support.
    expect(
      describeVoucherReachShortfall([voucherOn(null), voucherOn(null)], {
        fromDate: '2023-04-01',
        toDate: '2024-03-31',
      })
    ).toBeNull();
  });
});
