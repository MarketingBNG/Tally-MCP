import { describe, it, expect } from 'vitest';
import { parseTallyAmount, toMoney, isNegative, absolute } from '../../src/utils/numbers.js';

describe('parseTallyAmount', () => {
  it('preserves sign exactly as Tally sent it', () => {
    expect(parseTallyAmount('-1234.50')).toBe('-1234.5');
    expect(parseTallyAmount('1234.50')).toBe('1234.5');
  });

  it('strips thousands separators and currency symbols', () => {
    expect(parseTallyAmount('1,23,456.78')).toBe('123456.78'); // Indian grouping
    expect(parseTallyAmount('Rs. 1,000.00')).toBe('1000');
    expect(parseTallyAmount('₹1,000.50')).toBe('1000.5');
  });

  it('reads the sign correctly regardless of where it sits', () => {
    // A currency prefix ending in a dot ("Rs.") must not be mistaken for
    // part of the number, and the sign can precede or follow the symbol.
    expect(parseTallyAmount('-Rs. 500')).toBe('-500');
    expect(parseTallyAmount('Rs. -500')).toBe('-500');
    expect(parseTallyAmount('(500.25)')).toBe('-500.25'); // accounting negative
  });

  it('handles a trailing decimal point', () => {
    expect(parseTallyAmount('5000.')).toBe('5000');
  });

  it('drops a Dr/Cr presentation suffix without altering the number', () => {
    // The side belongs on the ledger entry, not on the amount.
    expect(parseTallyAmount('5000.00 Dr')).toBe('5000');
    expect(parseTallyAmount('5000.00 Cr')).toBe('5000');
    expect(parseTallyAmount('-5000.00 Cr')).toBe('-5000');
  });

  it('returns null rather than inventing a zero', () => {
    // A fabricated 0.00 in an audit context is worse than an admitted gap.
    expect(parseTallyAmount('')).toBeNull();
    expect(parseTallyAmount('   ')).toBeNull();
    expect(parseTallyAmount(null)).toBeNull();
    expect(parseTallyAmount(undefined)).toBeNull();
    expect(parseTallyAmount('not a number')).toBeNull();
    expect(parseTallyAmount('-')).toBeNull();
  });

  it('handles numeric input without floating-point drift', () => {
    expect(parseTallyAmount(0.1 + 0.2)).toBe('0.30000000000000004');
    expect(parseTallyAmount(1234.5)).toBe('1234.5');
  });

  it('keeps precision that a float would lose', () => {
    expect(parseTallyAmount('12345678901234567.89')).toBe('12345678901234567.89');
  });
});

describe('toMoney', () => {
  it('defaults to INR and carries the parsed amount', () => {
    expect(toMoney('1234.50')).toEqual({ amount: '1234.5', currency: 'INR' });
  });

  it('honours an explicit currency', () => {
    expect(toMoney('99.00', 'USD')).toEqual({ amount: '99', currency: 'USD' });
  });

  it('returns null when the amount is unparseable', () => {
    expect(toMoney('garbage')).toBeNull();
  });
});

describe('Money arithmetic', () => {
  it('detects negatives without coercing them', () => {
    expect(isNegative({ amount: '-1', currency: 'INR' })).toBe(true);
    expect(isNegative({ amount: '1', currency: 'INR' })).toBe(false);
    expect(isNegative({ amount: '0', currency: 'INR' })).toBe(false);
  });

  it('computes absolute values while preserving currency', () => {
    expect(absolute({ amount: '-1234.5', currency: 'INR' })).toEqual({
      amount: '1234.5',
      currency: 'INR',
    });
  });

});
