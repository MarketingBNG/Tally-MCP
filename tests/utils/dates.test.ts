import { describe, it, expect } from 'vitest';
import {
  bookYearFor,
  daysBetween,
  endDateBinds,
  isValidIsoDate,
  isoToTallyDate,
  nearestBindingEndDate,
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

/**
 * The company-anchored book year. These cases exist because the April-only
 * `financialYearFor` shipped a visibly wrong period on a calendar-year company:
 * it returned a year that did not contain the company's own start date, and the
 * warning built on it told the user the figures covered a date EARLIER than the
 * period they had asked about.
 */
describe('bookYearFor', () => {
  it('matches the Indian financial year when the books begin in April', () => {
    // The case financialYearFor already handled — it must not regress.
    expect(bookYearFor('2021-04-01', '2021-08-01')).toEqual({
      fromDate: '2021-04-01',
      toDate: '2022-03-31',
    });
  });

  it('gives a January-to-December year when the books begin in January', () => {
    // AGBV Nutrition GmbH, verified live 2026-08-14: books from 2023-01-01,
    // data to 2026-07-31, and Tally accumulated to December 2026.
    expect(bookYearFor('2023-01-01', '2026-07-31')).toEqual({
      fromDate: '2026-01-01',
      toDate: '2026-12-31',
    });
  });

  it('picks the window containing the anchor date, not the first one', () => {
    expect(bookYearFor('2021-04-01', '2024-01-15')).toEqual({
      fromDate: '2023-04-01',
      toDate: '2024-03-31',
    });
  });

  it('steps back a year when the date precedes that year\u2019s anchor', () => {
    // 2024-02-10 is before 1 April, so the containing window opened in 2023.
    expect(bookYearFor('2021-04-01', '2024-02-10')).toEqual({
      fromDate: '2023-04-01',
      toDate: '2024-03-31',
    });
  });

  it('handles a mid-month start date', () => {
    expect(bookYearFor('2022-07-15', '2023-01-01')).toEqual({
      fromDate: '2022-07-15',
      toDate: '2023-07-14',
    });
  });

  it('handles a 29 February start without producing an impossible end date', () => {
    // 2024-02-29 plus a year would be 2025-02-29, which does not exist. The
    // year must end 2025-02-28, not roll forward into March.
    expect(bookYearFor('2024-02-29', '2024-06-01')).toEqual({
      fromDate: '2024-02-29',
      toDate: '2025-02-28',
    });
  });

  it('always returns a range whose start is on or before its end', () => {
    // The specific failure observed live: an inverted range reaching a user.
    for (const start of ['2023-01-01', '2021-04-01', '2022-07-15', '2024-02-29']) {
      for (const on of ['2021-01-01', '2024-02-10', '2026-07-31', '2026-12-31']) {
        const range = bookYearFor(start, on);
        expect(range.fromDate <= range.toDate).toBe(true);
      }
    }
  });

  it('returns a window that contains the anchor date', () => {
    for (const start of ['2023-01-01', '2021-04-01', '2022-07-15']) {
      for (const on of ['2024-02-10', '2026-07-31', '2026-12-31']) {
        const range = bookYearFor(start, on);
        expect(on >= range.fromDate && on <= range.toDate).toBe(true);
      }
    }
  });
});

/**
 * Established by sweeping SVTODATE against a live TallyPrime with the cache off
 * (scripts/probe-todate-binding.ts, 2026-08-14). Nineteen observations, no
 * exceptions. The values below are the observed ones, not invented examples.
 */
describe('endDateBinds', () => {
  it('honours the 31st', () => {
    for (const date of [
      '2024-01-31',
      '2024-03-31',
      '2024-05-31',
      '2024-07-31',
      '2024-08-31',
      '2024-12-31',
    ]) {
      expect(endDateBinds(date)).toBe(true);
    }
  });

  it('does not honour any other day', () => {
    for (const date of [
      '2024-02-29',
      '2024-03-15',
      '2024-03-30',
      '2024-04-30',
      '2024-06-30',
      '2024-09-30',
      '2024-02-28',
    ]) {
      expect(endDateBinds(date)).toBe(false);
    }
  });

  /**
   * The observation that rules out "the last day of the month" as the rule.
   * 30 November is a real month end and Tally still ignored it, returning the
   * whole book year.
   */
  it('does not honour 30 November, a real month end that is not a 31st', () => {
    expect(endDateBinds('2024-11-30')).toBe(false);
  });
});

describe('nearestBindingEndDate', () => {
  it('returns the date unchanged when it already binds', () => {
    expect(nearestBindingEndDate('2024-03-31')).toBe('2024-03-31');
  });

  it('steps back to the previous month when that month has a 31st', () => {
    expect(nearestBindingEndDate('2024-06-30')).toBe('2024-05-31');
    expect(nearestBindingEndDate('2024-09-30')).toBe('2024-08-31');
  });

  it('crosses a year boundary', () => {
    expect(nearestBindingEndDate('2024-01-15')).toBe('2023-12-31');
  });

  it('returns null when the previous month has no 31st', () => {
    // March back to February: no 31st exists to suggest, so suggest nothing
    // rather than a date that would be silently ignored in turn.
    expect(nearestBindingEndDate('2024-03-15')).toBeNull();
  });

  it('never suggests a date that would itself be ignored', () => {
    for (const day of ['2024-01-15', '2024-04-30', '2024-06-30', '2024-11-30', '2025-02-28']) {
      const suggestion = nearestBindingEndDate(day);
      if (suggestion !== null) expect(endDateBinds(suggestion)).toBe(true);
    }
  });
});

describe('bookYearFor against the live-measured accumulation endpoint', () => {
  /**
   * These lock a number that was MEASURED, not derived.
   *
   * On 2026-08-14, against MUDALS TECHNOLOGIES PRIVATE LIMITED (books
   * 2021-04-01 to 2026-07-28), a statement whose end date did not bind
   * accumulated to 2027-03-31 from EVERY start date tried — six sweeps, from
   * 2021-04-01 through 2026-04-01, all landing on the same endpoint:
   *
   *   from 2021-04-01 -> 72 month rows    from 2024-04-01 -> 36 rows
   *   from 2022-04-01 -> 60 month rows    from 2025-04-01 -> 24 rows
   *   from 2023-04-01 -> 48 month rows    from 2026-04-01 -> 12 rows
   *
   * `bookYearFor(start, endingAt)` predicts exactly that, which is what makes it
   * the right anchor. The bug it replaced anchored on the books' START date and
   * produced 2022-03-31 — an end BEFORE the requested period's start, printed in
   * a user-facing warning. That wrong value was still being served live because
   * the built `dist/` was stale, which is why build freshness is now gated.
   */
  it('predicts the measured endpoint when anchored on the books end date', () => {
    expect(bookYearFor('2021-04-01', '2026-07-28').toDate).toBe('2027-03-31');
  });

  it('reproduces the old wrong value only when wrongly anchored on the start', () => {
    // Kept as a guard: if someone re-anchors this on `startingFrom`, the assertion
    // above fails and this one documents precisely what they will have re-broken.
    expect(bookYearFor('2021-04-01', '2021-04-01').toDate).toBe('2022-03-31');
  });

  it('never returns an end date before the period a caller asked about', () => {
    // The user-visible symptom of the original bug, stated as an invariant.
    const requestedFrom = '2023-04-01';
    const accumulationEnd = bookYearFor('2021-04-01', '2026-07-28').toDate;
    expect(accumulationEnd >= requestedFrom).toBe(true);
  });

  it('anchors on a January-December company without assuming April', () => {
    // The calendar-year case that first exposed the assumed-April bug.
    expect(bookYearFor('2021-01-01', '2026-07-28')).toEqual({
      fromDate: '2026-01-01',
      toDate: '2026-12-31',
    });
  });
});
