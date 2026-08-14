import { describe, it, expect } from 'vitest';
import {
  ageBills,
  scheduleIiiBoundaries,
  validateBuckets,
  SCHEDULE_III_LABELS,
  type DatedBillAllocation,
} from '../../src/tools/ageing.js';

/**
 * Schedule III ageing buckets, and overdue from caller-supplied credit terms.
 *
 * The 30/60/90 buckets this server shipped with are a management view. Schedule
 * III to the Companies Act requires a different split, in calendar periods
 * rather than day counts — which is the detail worth testing, because a fixed
 * 182 days puts a bill within a few days of the 6-month boundary in the wrong
 * DISCLOSURE bucket.
 */

function allocation(
  overrides: Partial<DatedBillAllocation> & { reference: string }
): DatedBillAllocation {
  return {
    voucherDate: '2026-01-15',
    billType: 'New Ref',
    amount: { amount: '-1000', currency: 'INR' },
    fields: {},
    ...overrides,
  };
}

/**
 * The disclosure buckets only.
 *
 * `ageBills` returns a leading "future-dated" bucket for bills dated after the
 * as-at date. Schedule III has no line for those, so they are reported
 * separately rather than folded into "less than 6 months" — a future-dated
 * invoice is a thing to ask about, not the youngest bucket.
 */
function disclosure(buckets: { label: string }[] | undefined): { count: number; toDay: number | null }[] {
  return ((buckets ?? []) as { label: string; count: number; toDay: number | null }[]).filter(
    (bucket) => bucket.label !== 'future-dated'
  );
}

describe('Schedule III boundaries', () => {
  it('produces four boundaries, giving the five disclosure buckets', () => {
    expect(scheduleIiiBoundaries('2027-03-31')).toHaveLength(4);
    expect(SCHEDULE_III_LABELS).toHaveLength(5);
  });

  it('uses real calendar months, not a fixed day count', () => {
    // 6 months back from 30 September is 181 days; from 31 March it is 184.
    // A hard-coded 182 would be wrong in both directions, which in a statutory
    // disclosure means a bill in the wrong bucket of the published note.
    const [septemberSixMonths] = scheduleIiiBoundaries('2026-09-30');
    const [marchSixMonths] = scheduleIiiBoundaries('2027-03-31');
    expect(septemberSixMonths).not.toBe(marchSixMonths);
  });

  it('ascends strictly, so the buckets cannot overlap', () => {
    // Feeding these straight into validateBuckets is the real contract: an
    // overlapping boundary list double-counts a bill, which is a wrong figure
    // that looks like a right one.
    expect(() => validateBuckets(scheduleIiiBoundaries('2027-03-31'))).not.toThrow();
  });

  it('holds up across a leap year', () => {
    expect(() => validateBuckets(scheduleIiiBoundaries('2028-02-29'))).not.toThrow();
  });

  it('puts a bill aged exactly six months in the SECOND bucket', () => {
    // The first bucket is "LESS than 6 months", so the boundary belongs to the
    // bucket above it. Off by one here misstates the disclosure.
    const asOn = '2026-09-30';
    const buckets = validateBuckets(scheduleIiiBoundaries(asOn));
    const result = ageBills(
      [allocation({ reference: 'INV-1', voucherDate: '2026-03-30' })],
      asOn,
      buckets,
      []
    );

    // Index 0 is the "future-dated" bucket, which is not a Schedule III line;
    // the five disclosure buckets follow it.
    expect(disclosure(result?.buckets)[0]?.count).toBe(0);
    expect(disclosure(result?.buckets)[1]?.count).toBe(1);
  });

  it('puts a recent bill in the first bucket', () => {
    const asOn = '2026-09-30';
    const result = ageBills(
      [allocation({ reference: 'INV-2', voucherDate: '2026-09-01' })],
      asOn,
      validateBuckets(scheduleIiiBoundaries(asOn)),
      []
    );
    expect(disclosure(result?.buckets)[0]?.count).toBe(1);
  });

  it('puts a four-year-old bill in the open-ended final bucket', () => {
    const asOn = '2026-09-30';
    const result = ageBills(
      [allocation({ reference: 'INV-3', voucherDate: '2022-09-01' })],
      asOn,
      validateBuckets(scheduleIiiBoundaries(asOn)),
      []
    );
    expect(disclosure(result?.buckets)[4]?.count).toBe(1);
    expect(disclosure(result?.buckets)[4]?.toDay).toBeNull();
  });
});

describe('overdue from caller-supplied credit terms', () => {
  const asOn = '2026-06-30';

  it('omits overdue entirely when no terms were given', () => {
    // Not a zero. A zero would read as "nothing is overdue", which cannot be
    // said without knowing when each bill was due.
    const result = ageBills(
      [allocation({ reference: 'INV-1', voucherDate: '2026-01-01' })],
      asOn,
      [30, 60, 90],
      []
    );
    expect(result?.overdue).toBeUndefined();
  });

  it('counts a bill past its credit period', () => {
    const result = ageBills(
      [allocation({ reference: 'INV-1', voucherDate: '2026-01-01' })],
      asOn,
      [30, 60, 90],
      [],
      30
    );
    expect(result?.overdue?.count).toBe(1);
    expect(result?.overdue?.creditDays).toBe(30);
  });

  it('does not count a bill inside its credit period', () => {
    const result = ageBills(
      [allocation({ reference: 'INV-1', voucherDate: '2026-06-20' })],
      asOn,
      [30, 60, 90],
      [],
      30
    );
    expect(result?.overdue?.count).toBe(0);
  });

  it('treats a bill on its due date as due, not overdue', () => {
    // 30 days old with 30 days' credit is due today. Calling it overdue would
    // overstate the receivable position by a day on every single bill.
    const result = ageBills(
      [allocation({ reference: 'INV-1', voucherDate: '2026-05-31' })],
      asOn,
      [30, 60, 90],
      [],
      30
    );
    expect(result?.overdue?.count).toBe(0);
  });

  it('carries the basis, so the figure cannot be quoted without it', () => {
    const result = ageBills(
      [allocation({ reference: 'INV-1', voucherDate: '2026-01-01' })],
      asOn,
      [30, 60, 90],
      [],
      0
    );
    expect(result?.overdue?.basis).toContain('caller-supplied');
  });

  it('does not count a settled bill as overdue however old it is', () => {
    // Netting runs first, so a raised-and-settled reference is not outstanding
    // and therefore cannot be overdue.
    const result = ageBills(
      [
        allocation({ reference: 'INV-1', voucherDate: '2026-01-01' }),
        allocation({
          reference: 'INV-1',
          voucherDate: '2026-02-01',
          billType: 'Agst Ref',
          amount: { amount: '1000', currency: 'INR' },
        }),
      ],
      asOn,
      [30, 60, 90],
      [],
      30
    );
    expect(result?.overdue?.count).toBe(0);
    expect(result?.settledInPeriod).toBe(1);
  });
});
