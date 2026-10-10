import { describe, it, expect } from 'vitest';
import { readMoney } from '../../src/tally/normalize/shared.js';

/**
 * Foreign-currency amounts arrive with their conversion written out, as in
 * "11228.00 € @ $1.16/ € = $13024.48". The base-currency figure after "=" is
 * the one TallyPrime's own reports total, so it is the one read.
 */
function read(raw: string): { amount: string | null; warnings: string[] } {
  const warnings: string[] = [];
  const money = readMoney(raw, 'X', warnings, '$');
  return { amount: money?.amount ?? null, warnings };
}

describe('readMoney with a foreign-currency amount', () => {
  it('reads the converted base value and says so', () => {
    const { amount, warnings } = read('11228.00 € @ $1.16/ € = $13024.48');
    expect(amount).toBe('13024.48');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('converted base value 13024.48');
  });

  it('keeps a sign shown on both sides', () => {
    expect(read('-11228.00 € @ $1.16/ € = -$13024.48').amount).toBe('-13024.48');
  });

  it('keeps a sign shown only on the foreign side, never turning a credit into a debit', () => {
    expect(read('-11228.00 € @ $1.16/ € = $13024.48').amount).toBe('-13024.48');
  });

  it('reads a converted value with separators, a spaced symbol or a Dr/Cr suffix', () => {
    expect(read('11228.00 € @ $1.16/ € = $13,024.48').amount).toBe('13024.48');
    expect(read('11228.00 € @ $1.16/ € = $ 13024.48').amount).toBe('13024.48');
    expect(read('11228.00 € @ $1.16/ € = $13024.48 Dr').amount).toBe('13024.48');
  });

  it('leaves a plain amount untouched, with no warning', () => {
    expect(read('13024.48')).toEqual({ amount: '13024.48', warnings: [] });
  });

  it('reports an unreadable amount as null rather than guessing', () => {
    expect(read('11228.00 € @ $1.16/ € = rubbish').amount).toBeNull();
    const { amount, warnings } = read('garbage');
    expect(amount).toBeNull();
    expect(warnings[0]).toContain('Could not read');
  });
});
