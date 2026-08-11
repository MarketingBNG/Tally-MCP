import { describe, it, expect } from 'vitest';
import { TallyError, TALLY_ERROR_CODES } from '../../src/tally/TallyError.js';

describe('TallyError', () => {
  it('supplies a default suggestion for every declared code', () => {
    // A code with no remediation text is a code that leaves the user stuck.
    for (const code of TALLY_ERROR_CODES) {
      const error = new TallyError(code, 'test message');
      expect(error.suggestion, `${code} has no default suggestion`).toBeTruthy();
    }
  });

  it('allows a call site to override the suggestion', () => {
    const error = new TallyError('RESULT_LIMIT_EXCEEDED', 'too big', {
      suggestion: 'Try one month at a time.',
    });
    expect(error.suggestion).toBe('Try one month at a time.');
  });

  it('never exposes a stack trace, cause, or context to the client', () => {
    const error = new TallyError('TALLY_TIMEOUT', 'Tally did not respond.', {
      cause: new Error('ECONNRESET at 10.0.0.1'),
      context: { rawPayload: '<ENVELOPE>secret ledger data</ENVELOPE>' },
    });

    const payload = error.toClientPayload();
    const serialised = JSON.stringify(payload);

    expect(Object.keys(payload)).toEqual(['error']);
    expect(Object.keys(payload.error).sort()).toEqual(['code', 'message', 'suggestion']);
    expect(serialised).not.toContain('ECONNRESET');
    expect(serialised).not.toContain('secret ledger data');
    expect(serialised).not.toContain('at Object');
  });

  it('keeps cause and context available locally for logging', () => {
    const cause = new Error('underlying');
    const error = new TallyError('TALLY_INVALID_RESPONSE', 'bad xml', {
      cause,
      context: { bytes: 42 },
    });

    expect(error.cause).toBe(cause);
    expect(error.context).toEqual({ bytes: 42 });
  });

  it('identifies its own instances', () => {
    expect(TallyError.isTallyError(new TallyError('TALLY_TIMEOUT', 'x'))).toBe(true);
    expect(TallyError.isTallyError(new Error('x'))).toBe(false);
    expect(TallyError.isTallyError(null)).toBe(false);
    expect(TallyError.isTallyError('TALLY_TIMEOUT')).toBe(false);
  });

  describe('from', () => {
    it('passes an existing TallyError through unchanged', () => {
      const original = new TallyError('TALLY_COMPANY_NOT_LOADED', 'nope');
      expect(TallyError.from(original)).toBe(original);
    });

    it('wraps an arbitrary throw so nothing raw can escape', () => {
      const wrapped = TallyError.from(new Error('socket hang up'));
      expect(wrapped).toBeInstanceOf(TallyError);
      expect(wrapped.code).toBe('TALLY_CONNECTION_FAILED');
      // The original detail is retained locally but kept out of the payload.
      expect(JSON.stringify(wrapped.toClientPayload())).not.toContain('socket hang up');
    });

    it('wraps non-Error throws', () => {
      expect(TallyError.from('a string').code).toBe('TALLY_CONNECTION_FAILED');
      expect(TallyError.from(undefined).code).toBe('TALLY_CONNECTION_FAILED');
    });
  });
});
