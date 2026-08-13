import { describe, it, expect } from 'vitest';
import { matchesText } from '../../src/utils/text.js';

describe('matchesText', () => {
  it('matches a substring regardless of case', () => {
    expect(matchesText('bramley', 'Bramley Traders Ltd')).toBe(true);
    expect(matchesText('BRAMLEY', 'Bramley Traders Ltd')).toBe(true);
  });

  it('matches when any one of several fields contains the term', () => {
    expect(matchesText('debtors', 'Acme Ltd', 'Sundry Debtors')).toBe(true);
  });

  it('does not match across a field boundary', () => {
    // A joined haystack would match "Ltd Sundry" here. That hit is an artefact
    // of the join, not something present in the data, so it must not match.
    expect(matchesText('Ltd Sundry', 'Acme Ltd', 'Sundry Debtors')).toBe(false);
  });

  it('skips null and undefined rather than treating them as empty strings', () => {
    expect(matchesText('anything', null, undefined)).toBe(false);
    // The dangerous case: an empty needle must not make an absent field match.
    expect(matchesText('', null)).toBe(false);
  });

  it('reports no match when nothing contains the term', () => {
    expect(matchesText('zzz', 'Acme Ltd', 'Sundry Debtors')).toBe(false);
  });
});
