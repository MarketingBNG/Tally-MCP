import { describe, it, expect } from 'vitest';
import {
  parseTallyAmount,
  toMoney,
  isNegative,
  absolute,
  currencyIsUnavailable,
} from '../../src/utils/numbers.js';

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

  /**
   * The regression that matters most in this file.
   *
   * The parser used to delete every non-digit and then treat the LAST dot as the
   * decimal point, which salvaged a number out of anything containing digits.
   * On Tally's own stock strings that produced a figure wrong by 100x, with no
   * warning, because the unit's trailing dot became the decimal point:
   *
   *   "1000.00 Kgs." -> "100000"
   *
   * Those strings are what `StockItem.closingRate` and the quantity fields hold,
   * so this was one call away from reporting a rate 100x too high. Refusing is
   * the only safe answer: a null makes the caller warn, a salvaged number does
   * not. Same rule for anything ambiguous — two dots, or European grouping.
   */
  it('refuses to salvage a number out of a value it cannot read', () => {
    // Tally's real stock quantity and rate formats, observed live.
    expect(parseTallyAmount('1000.00 Kgs.')).toBeNull();
    expect(parseTallyAmount('20.00/Kgs.')).toBeNull();
    // Ambiguous or malformed rather than merely noisy.
    expect(parseTallyAmount('1.2.3')).toBeNull();
    expect(parseTallyAmount('1.234,50')).toBeNull(); // European grouping
    expect(parseTallyAmount('1e3')).toBeNull();
    // An illegal-character reference that escaped sanitisation must not read as 4.
    expect(parseTallyAmount('&#4; Not Applicable')).toBeNull();
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

/**
 * Detecting a currency symbol TallyPrime could not transport.
 *
 * Found live 2026-08-14: a German company reported its base currency as a literal
 * `?` (byte 0x3F), because the euro sign is not in the codepage TallyPrime exports
 * with and it substitutes before the data leaves. Ten encoding settings were
 * probed and none changed it, so this cannot be recovered — only reported.
 *
 * The consequence of NOT detecting it: every figure labelled `"currency": "?"`,
 * which reads as data. Defaulting instead would label euro balances INR.
 */
describe('currencyIsUnavailable', () => {
  it('detects the substituted question mark', () => {
    expect(currencyIsUnavailable('?')).toBe(true);
  });

  it('detects a replacement character, in case a payload was mangled not substituted', () => {
    expect(currencyIsUnavailable('\uFFFD')).toBe(true);
  });

  it('detects a run of them', () => {
    // A multi-character symbol whose every character was substituted.
    expect(currencyIsUnavailable('??')).toBe(true);
    expect(currencyIsUnavailable('?\uFFFD')).toBe(true);
  });

  it('tolerates surrounding whitespace', () => {
    expect(currencyIsUnavailable('  ?  ')).toBe(true);
  });

  it('accepts real symbols, including ones that survived transport', () => {
    // These must NOT be treated as unavailable, or a working company would start
    // reporting "unknown" for a currency Tally reported perfectly well.
    for (const symbol of ['$', 'INR', 'Rs.', '\u20B9', '\u20AC', 'USD', 'CHF', '\u00A3']) {
      expect(currencyIsUnavailable(symbol)).toBe(false);
    }
  });

  it('does not fire on a symbol that merely contains a question mark', () => {
    // Only a fully-substituted symbol is unreadable. A partial one still carries
    // information, and blanking it would discard what did arrive.
    expect(currencyIsUnavailable('R?')).toBe(false);
  });

  it('treats absent and empty as not-unavailable, leaving the existing default path alone', () => {
    // "Tally reported nothing" is a different case from "Tally substituted it",
    // and it already has its own handling. Conflating them would change verified
    // behaviour on companies that report no currency at all.
    expect(currencyIsUnavailable(null)).toBe(false);
    expect(currencyIsUnavailable(undefined)).toBe(false);
    expect(currencyIsUnavailable('')).toBe(false);
    expect(currencyIsUnavailable('   ')).toBe(false);
  });
});
