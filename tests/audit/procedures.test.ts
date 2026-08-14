import { describe, it, expect } from 'vitest';
import type { Voucher } from '../../src/tally/normalize.js';
import {
  benford,
  findCutOffEntries,
  findDuplicates,
  findRoundNumbers,
  findWeekendDated,
  sampleVouchers,
  screenJournals,
  voucherMagnitude,
  weekdayOf,
} from '../../src/audit/procedures.js';

/**
 * The audit procedures, against populations built by hand.
 *
 * The point of testing these against constructed data rather than a fixture is
 * that every case here has a KNOWN answer. A Benford result computed over real
 * vouchers can only be checked for plausibility, and "plausible" is exactly the
 * standard that let nine wrong figures through in 0.2.0. A synthetic
 * Benford-conforming population has a right answer, and so does a sample drawn
 * from a seed.
 */

function voucher(overrides: Partial<Voucher> = {}): Voucher {
  return {
    guid: 'g',
    date: '2026-05-15',
    voucherType: 'Sales',
    voucherNumber: 'V-1',
    partyLedgerName: 'Northwind Retail',
    narration: 'Goods sold',
    isCancelled: false,
    isOptional: false,
    isOrderVoucher: false,
    isInventoryVoucher: false,
    entries: [],
    source: { system: 'tallyprime', entityType: 'voucher' },
    ...overrides,
  } as Voucher;
}

/** A voucher whose magnitude is `amount`, built from a balanced entry pair. */
function withAmount(amount: string, overrides: Partial<Voucher> = {}): Voucher {
  return voucher({
    entries: [
      { ledgerName: 'Debtors', amount: { amount: `-${amount}`, currency: 'INR' }, side: 'debit' },
      { ledgerName: 'Sales', amount: { amount, currency: 'INR' }, side: 'credit' },
    ],
    ...overrides,
  });
}

describe('voucherMagnitude', () => {
  it('takes the largest absolute entry, not the sum', () => {
    // The sum of a balanced voucher is zero. A tool judging size by the sum
    // would rank every voucher equally, which is the bug this guards.
    expect(voucherMagnitude(withAmount('1500'))?.toFixed()).toBe('1500');
  });

  it('is null when no entry carries a readable amount', () => {
    // Not zero. A zero magnitude would sort alongside genuine zero-value
    // vouchers and would be counted as a round number by every multiple.
    const v = voucher({ entries: [{ ledgerName: 'X', amount: null, side: 'debit' }] });
    expect(voucherMagnitude(v)).toBeNull();
  });
});

describe('round numbers', () => {
  it('flags exact multiples and leaves the rest alone', () => {
    const found = findRoundNumbers(
      [withAmount('5000'), withAmount('5001'), withAmount('250000')],
      1000
    );
    expect(found.map((c) => c.amount)).toEqual(['5000', '250000']);
  });

  it('never flags zero', () => {
    // Zero is a multiple of everything. Flagging it would be arithmetically
    // true and analytically worthless, and it would pad every result.
    expect(findRoundNumbers([withAmount('0')], 1000)).toHaveLength(0);
  });

  it('respects the scale it was given', () => {
    expect(findRoundNumbers([withAmount('5000')], 100000)).toHaveLength(0);
  });
});

describe('duplicates', () => {
  it('groups only when party, amount and date all agree', () => {
    const { groups } = findDuplicates([
      withAmount('1000', { voucherNumber: 'A' }),
      withAmount('1000', { voucherNumber: 'B' }),
      // Same party and amount, different day — ordinary trade, not a duplicate.
      withAmount('1000', { voucherNumber: 'C', date: '2026-05-16' }),
      // Same amount and day, different party.
      withAmount('1000', { voucherNumber: 'D', partyLedgerName: 'Acme' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((m) => m.voucherNumber)).toEqual(['A', 'B']);
  });

  it('refuses to group vouchers missing a party, amount or date, and counts them', () => {
    // Two unknowns are not a match. Grouping them would manufacture duplicates
    // out of missing data, which is worse than reporting the gap.
    const { groups, notComparable } = findDuplicates([
      withAmount('1000', { partyLedgerName: null }),
      withAmount('1000', { partyLedgerName: null }),
      voucher({ entries: [] }),
    ]);

    expect(groups).toHaveLength(0);
    expect(notComparable).toBe(3);
  });

  it('names the values a group shares rather than a hash', () => {
    const { groups } = findDuplicates([withAmount('1000'), withAmount('1000')]);
    expect(groups[0]?.matchedOn).toContain('Northwind Retail');
    expect(groups[0]?.matchedOn).toContain('1000');
    expect(groups[0]?.matchedOn).toContain('2026-05-15');
  });
});

describe('cut-off', () => {
  const period = { fromDate: '2026-04-01', toDate: '2026-03-31' };

  it('catches both ends of the period, and says which end', () => {
    const found = findCutOffEntries(
      [
        withAmount('1', { date: '2026-04-03', voucherNumber: 'OPEN' }),
        withAmount('1', { date: '2026-08-01', voucherNumber: 'MIDDLE' }),
      ],
      { fromDate: '2026-04-01', toDate: '2026-08-05' },
      7
    );

    expect(found.map((c) => c.voucherNumber)).toEqual(['OPEN', 'MIDDLE']);
    expect(found[0]?.reasons[0]).toContain('after the period opened');
    expect(found[1]?.reasons[0]).toContain('before the period closed');
  });

  it('leaves the middle of the period alone', () => {
    const found = findCutOffEntries([withAmount('1', { date: '2026-06-15' })], period, 7);
    expect(found).toHaveLength(0);
  });

  it('skips a voucher with no readable date instead of guessing one', () => {
    const found = findCutOffEntries([withAmount('1', { date: null })], period, 7);
    expect(found).toHaveLength(0);
  });
});

describe('weekend dating', () => {
  it('reads the day in UTC so no local timezone can shift it', () => {
    // A local-time read would move a Saturday to a Friday or Sunday depending
    // on where the server happens to run, which would make the result
    // machine-dependent — unacceptable for something quoted in a workpaper.
    expect(weekdayOf('2026-05-16')).toBe('Saturday');
    expect(weekdayOf('2026-05-17')).toBe('Sunday');
    expect(weekdayOf('2026-05-18')).toBe('Monday');
  });

  it('flags Saturday and Sunday only', () => {
    const found = findWeekendDated([
      withAmount('1', { date: '2026-05-16', voucherNumber: 'SAT' }),
      withAmount('1', { date: '2026-05-17', voucherNumber: 'SUN' }),
      withAmount('1', { date: '2026-05-18', voucherNumber: 'MON' }),
    ]);
    expect(found.map((c) => c.voucherNumber)).toEqual(['SAT', 'SUN']);
  });
});

describe('Benford', () => {
  /**
   * A population whose first digits follow Benford's expectation closely.
   *
   * Built by allocating counts in proportion to log10(1 + 1/d) over 1,000
   * amounts, so the answer is known before the test runs: a conforming
   * population must come back inside Nigrini's close-conformity band.
   */
  function conformingPopulation(): Voucher[] {
    const expected = [0.301, 0.176, 0.125, 0.097, 0.079, 0.067, 0.058, 0.051, 0.046];
    const vouchers: Voucher[] = [];
    expected.forEach((proportion, index) => {
      const digit = index + 1;
      const count = Math.round(proportion * 1000);
      for (let i = 0; i < count; i += 1) {
        // Vary the trailing digits so the second digit is spread too.
        vouchers.push(withAmount(`${String(digit)}${String(100 + (i % 900))}`));
      }
    });
    return vouchers;
  }

  it('calls a conforming population conforming', () => {
    const result = benford(conformingPopulation(), 1);
    expect(result.conformity).toBe('close conformity');
    expect(result.warnings.join(' ')).not.toContain('POPULATION TOO SMALL');
  });

  it('calls a rigged population nonconforming', () => {
    // Every amount leads with 9 — the digit Benford expects least often.
    const rigged = Array.from({ length: 400 }, (_, i) => withAmount(`9${String(100 + i)}`));
    const result = benford(rigged, 1);
    expect(result.conformity).toBe('nonconformity');
    expect(result.distribution.find((d) => d.digit === '9')?.observed).toBe(400);
  });

  it('warns loudly below the 300 floor rather than quietly returning a band', () => {
    const result = benford([withAmount('1234'), withAmount('5678')], 1);
    expect(result.population).toBe(2);
    expect(result.warnings.join(' ')).toContain('POPULATION TOO SMALL');
  });

  it('excludes an amount with fewer digits than the test needs, and says so', () => {
    // A single-digit 7 has no second digit. Padding it to "70" would invent a
    // leading pair the amount does not contain.
    const result = benford([withAmount('7')], 2);
    expect(result.population).toBe(0);
    expect(result.excluded.zeroOrUnreadable).toBe(1);
    expect(result.warnings.join(' ')).toContain('excluded rather than');
  });

  it('reads leading digits through the decimal point', () => {
    // 0.0123 leads with 1 exactly as 123 does — Benford is about significant
    // digits, not about magnitude.
    const result = benford([withAmount('0.0123')], 2);
    expect(result.distribution.find((d) => d.digit === '12')?.observed).toBe(1);
  });

  it('uses tighter bands for the two-digit test', () => {
    // The same deviation spread over 90 buckets rather than 9 is a much
    // smaller MAD, so a first-digit threshold would call everything conforming.
    const rigged = Array.from({ length: 400 }, (_, i) => withAmount(`9${String(100 + i)}`));
    expect(benford(rigged, 2).conformity).toBe('nonconformity');
  });

  it('covers all 90 buckets for the two-digit test and 9 for the one-digit test', () => {
    expect(benford([], 1).distribution).toHaveLength(9);
    expect(benford([], 2).distribution).toHaveLength(90);
  });
});

describe('sampling', () => {
  const population = Array.from({ length: 100 }, (_, i) =>
    withAmount(String(1000 + i), { voucherNumber: `V-${String(i)}`, guid: `g-${String(i)}` })
  );

  it('reproduces the same sample from the same seed', () => {
    // The property that makes a sample usable as a workpaper. If this ever
    // fails, every sample this server has ever drawn becomes unverifiable.
    const first = sampleVouchers(population, 10, 'seed-a', 'random');
    const second = sampleVouchers(population, 10, 'seed-a', 'random');
    expect(second.selected.map((s) => s.guid)).toEqual(first.selected.map((s) => s.guid));
  });

  it('gives a different sample for a different seed', () => {
    const a = sampleVouchers(population, 10, 'seed-a', 'random');
    const b = sampleVouchers(population, 10, 'seed-b', 'random');
    expect(b.selected.map((s) => s.guid)).not.toEqual(a.selected.map((s) => s.guid));
  });

  it('does not depend on the order the population arrived in', () => {
    // Tally's ordering is stable in practice but is not documented as a
    // guarantee, and a sample that depends on it would not reproduce.
    const shuffled = [...population].reverse();
    const a = sampleVouchers(population, 10, 'seed-a', 'random');
    const b = sampleVouchers(shuffled, 10, 'seed-a', 'random');
    expect(b.selected.map((s) => s.guid)).toEqual(a.selected.map((s) => s.guid));
  });

  it('never selects the same voucher twice', () => {
    const result = sampleVouchers(population, 30, 'seed-a', 'random');
    const guids = result.selected.map((s) => s.guid);
    expect(new Set(guids).size).toBe(30);
  });

  it('refuses to call a complete examination a sample', () => {
    const result = sampleVouchers(population.slice(0, 5), 5, 'seed-a', 'random');
    expect(result.selected).toHaveLength(5);
    expect(result.warnings.join(' ')).toContain('not smaller than the population');
  });

  it('discloses the bias in systematic selection', () => {
    const result = sampleVouchers(population, 10, 'seed-a', 'systematic');
    expect(result.selected).toHaveLength(10);
    expect(result.warnings.join(' ')).toContain('biased against anything periodic');
  });

  it('varies the systematic start with the seed', () => {
    // A fixed start of 0 would make two "different" seeds agree, which would
    // silently make the seed meaningless for this method.
    const seeds = ['a', 'b', 'c', 'd'].map(
      (seed) => sampleVouchers(population, 10, seed, 'systematic').selected[0]?.guid
    );
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });

  it('returns nothing from an empty population instead of failing', () => {
    const result = sampleVouchers([], 10, 'seed-a', 'random');
    expect(result.selected).toHaveLength(0);
    expect(result.populationSize).toBe(0);
  });
});

describe('journal screening', () => {
  it('collects every reason on one candidate rather than one per reason', () => {
    // Four attributes on one voucher is one candidate. Emitting four would
    // quadruple an apparent problem count, which is a false statement about size.
    const found = screenJournals(
      [
        withAmount('500000', {
          voucherType: 'Journal',
          narration: null,
          date: '2026-05-16',
        }),
      ],
      { threshold: '250000', roundMultipleOf: 1000 }
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.reasons).toHaveLength(4);
    expect(found[0]?.reasons.join(' ')).toContain('threshold');
    expect(found[0]?.reasons.join(' ')).toContain('multiple');
    expect(found[0]?.reasons.join(' ')).toContain('Saturday');
  });

  it('says nothing about an ordinary journal', () => {
    const found = screenJournals(
      [withAmount('12345.67', { voucherType: 'Journal', date: '2026-05-18' })],
      { threshold: '250000', roundMultipleOf: 1000 }
    );
    expect(found).toHaveLength(0);
  });

  it('does not test size when no threshold was given', () => {
    // Materiality is a judgement, not a property of the data, so there is no
    // default to fall back on — the attribute is simply not tested.
    const found = screenJournals(
      [withAmount('9000000', { voucherType: 'Journal', date: '2026-05-18' })],
      { roundMultipleOf: 1000000000 }
    );
    expect(found).toHaveLength(0);
  });

  it('treats a whitespace-only narration as no narration', () => {
    const found = screenJournals(
      [withAmount('12345.67', { voucherType: 'Journal', narration: '   ', date: '2026-05-18' })],
      { roundMultipleOf: 1000 }
    );
    expect(found[0]?.reasons.join(' ')).toContain('does not explain itself');
  });
});
