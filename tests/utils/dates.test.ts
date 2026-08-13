import { describe, it, expect } from 'vitest';
import {
  daysBetween,
  isValidIsoDate,
  isoToTallyDate,
  tallyDateToIso,
  validateDateRange,
  financialYearFor,
  todayIso,
} from '../../src/utils/dates.js';
import { TallyError } from '../../src/tally/TallyError.js';

describe('isValidIsoDate', () => {
  it('accepts real calendar days', () => {
    expect(isValidIsoDate('2026-04-01')).toBe(true);
    expect(isValidIsoDate('2024-02-29')).toBe(true); // leap year
  });

  it('rejects malformed or impossible dates', () => {
    expect(isValidIsoDate('2026-4-1')).toBe(false); // not zero-padded
    expect(isValidIsoDate('20260401')).toBe(false); // Tally format, not ISO
    expect(isValidIsoDate('2026-13-01')).toBe(false); // month out of range
    expect(isValidIsoDate('2026-02-30')).toBe(false); // day out of range
    expect(isValidIsoDate('2025-02-29')).toBe(false); // not a leap year
    expect(isValidIsoDate('')).toBe(false);
  });
});

describe('Tally date conversion', () => {
  it('round-trips between ISO and Tally formats', () => {
    expect(isoToTallyDate('2026-04-01')).toBe('20260401');
    expect(tallyDateToIso('20260401')).toBe('2026-04-01');
  });

  it('returns null for unparseable Tally dates rather than guessing', () => {
    expect(tallyDateToIso('')).toBeNull();
    expect(tallyDateToIso('2026-04-01')).toBeNull();
    expect(tallyDateToIso('20261301')).toBeNull(); // month 13
  });

  it('tolerates surrounding whitespace from XML text nodes', () => {
    expect(tallyDateToIso('  20260401  ')).toBe('2026-04-01');
  });
});

describe('validateDateRange', () => {
  it('accepts a well-ordered range', () => {
    expect(validateDateRange('2026-04-01', '2026-04-30')).toEqual({
      fromDate: '2026-04-01',
      toDate: '2026-04-30',
    });
  });

  it('accepts a single-day range', () => {
    expect(validateDateRange('2026-04-01', '2026-04-01').fromDate).toBe('2026-04-01');
  });

  it('rejects a reversed range with INVALID_DATE_RANGE', () => {
    try {
      validateDateRange('2026-04-30', '2026-04-01');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(TallyError.isTallyError(error)).toBe(true);
      expect((error as TallyError).code).toBe('INVALID_DATE_RANGE');
      // The message must name both values so the user can see what was wrong.
      expect((error as TallyError).message).toContain('2026-04-30');
      expect((error as TallyError).message).toContain('2026-04-01');
    }
  });

  it('names the offending parameter when a date is malformed', () => {
    expect(() => validateDateRange('nonsense', '2026-04-01')).toThrowError(/fromDate/);
    expect(() => validateDateRange('2026-04-01', 'nonsense')).toThrowError(/toDate/);
  });
});

describe('financialYearFor', () => {
  it('runs 1 April to 31 March', () => {
    expect(financialYearFor('2026-08-09')).toEqual({
      fromDate: '2026-04-01',
      toDate: '2027-03-31',
    });
  });

  it('places January in the financial year that began the previous April', () => {
    expect(financialYearFor('2026-01-15')).toEqual({
      fromDate: '2025-04-01',
      toDate: '2026-03-31',
    });
  });

  it('treats 1 April as the first day of a new year, and 31 March as the last of the old', () => {
    expect(financialYearFor('2026-04-01').fromDate).toBe('2026-04-01');
    expect(financialYearFor('2026-03-31').toDate).toBe('2026-03-31');
  });
});

describe('todayIso', () => {
  it('uses the local calendar day, not a UTC shift', () => {
    // Late-evening local time is the case where a naive UTC conversion would
    // roll the date forward and land a voucher in the wrong day/year.
    const lateEvening = new Date(2026, 3, 1, 23, 30, 0);
    expect(todayIso(lateEvening)).toBe('2026-04-01');
  });

  it('zero-pads month and day', () => {
    expect(todayIso(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('daysBetween', () => {
  it('counts whole calendar days', () => {
    expect(daysBetween('2026-07-01', '2026-07-31')).toBe(30);
    expect(daysBetween('2026-07-10', '2026-07-31')).toBe(21);
    expect(daysBetween('2026-07-31', '2026-07-31')).toBe(0);
  });

  it('spans months and years', () => {
    // 30 + 31 + 30 + 30 days: Apr 1 to Jul 31.
    expect(daysBetween('2026-04-01', '2026-07-31')).toBe(121);
    expect(daysBetween('2025-04-01', '2026-03-31')).toBe(364);
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2); // leap year
    expect(daysBetween('2025-02-28', '2025-03-01')).toBe(1);
  });

  it('goes negative when the second date is earlier', () => {
    expect(daysBetween('2026-07-31', '2026-07-01')).toBe(-30);
  });

  /**
   * The reason this is built on Date.UTC from the parts rather than by parsing
   * the strings: a DST transition inside the range must not add or drop a day,
   * and an ageing bucket boundary is exactly where that would surface.
   */
  it('is unaffected by daylight saving transitions in the range', () => {
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31);
    expect(daysBetween('2026-10-01', '2026-11-01')).toBe(31);
  });
});
