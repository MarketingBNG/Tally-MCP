import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TALLY_ERROR_CODES, TallyError, type TallyErrorCode } from '../../src/tally/TallyError.js';

/**
 * The error contract, enforced rather than described.
 *
 * The codes are the part of this server Claude reasons about: the message is
 * read, but the CODE is what a caller branches on, and the docstring in
 * TallyError.ts says they must not be renamed once shipped. That makes the list
 * a published interface, and an interface deserves tests that fail when it
 * drifts rather than a convention that erodes.
 *
 * Two properties matter most, and neither was checked before:
 *
 *   1. Every code can actually happen. A vocabulary that advertises a failure
 *      nothing can raise is a claim the contract does not keep — found live:
 *      `TALLY_AUTHENTICATION_ERROR` is thrown nowhere, because TallyPrime's HTTP
 *      interface has no authentication step. It is now labelled reserved, and
 *      the test below keeps every OTHER code honest.
 *
 *   2. Nothing untyped escapes. A raw exception crossing the MCP boundary would
 *      carry a stack trace — file paths, and potentially accounting data from a
 *      parse failure — into a client transcript.
 */

/** Every .ts file under src, so the assertions read the real source. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

const SRC = sourceFiles(join(process.cwd(), 'src'))
  // TallyError.ts declares every code; counting it would make each look used.
  .filter((path) => !path.endsWith('TallyError.ts'))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');

/**
 * Codes that are deliberately unreachable, with the reason they still exist.
 *
 * Adding to this list should be uncomfortable: it means the contract offers a
 * code nothing can raise.
 */
const RESERVED: Record<string, string> = {
  TALLY_AUTHENTICATION_ERROR:
    "TallyPrime's HTTP interface has no authentication step, so nothing can raise it. " +
    'Kept because the codes are a shipped contract and removal would break a consumer.',
};

describe('every error code is reachable, or documented as reserved', () => {
  it.each(TALLY_ERROR_CODES.filter((code) => !(code in RESERVED)))(
    '%s is thrown somewhere in src',
    (code) => {
      expect(SRC).toContain(`'${code}'`);
    }
  );

  it('names a reason for each reserved code', () => {
    for (const [code, reason] of Object.entries(RESERVED)) {
      expect(TALLY_ERROR_CODES).toContain(code as TallyErrorCode);
      expect(reason.length).toBeGreaterThan(40);
      // A reserved code must really be unreachable — otherwise it belongs above.
      expect(SRC).not.toContain(`'${code}'`);
    }
  });

  it('marks the reserved code as such in the source, not just in this test', () => {
    const declaration = readFileSync(join(process.cwd(), 'src/tally/TallyError.ts'), 'utf8');
    expect(declaration).toContain('RESERVED, and never thrown today');
  });
});

describe('every code carries actionable remediation', () => {
  it.each(TALLY_ERROR_CODES)('%s has a non-trivial default suggestion', (code) => {
    const error = new TallyError(code, 'something went wrong');
    // The suggestion is what tells a user how to fix it; an empty or stub one
    // makes the code useless at exactly the moment it is needed.
    expect(error.suggestion.length).toBeGreaterThan(20);
  });
});

describe('nothing untyped or internal crosses the boundary', () => {
  it('coerces an arbitrary throw into a typed error', () => {
    const coerced = TallyError.from(new Error('boom'), 'tool failed.');
    expect(TALLY_ERROR_CODES).toContain(coerced.code);
    expect(coerced.message).toBe('tool failed.');
  });

  it('coerces a non-Error throw too', () => {
    // A string or object thrown from a dependency must not escape either.
    for (const thrown of ['a string', { odd: true }, null, undefined, 42]) {
      const coerced = TallyError.from(thrown, 'tool failed.');
      expect(TALLY_ERROR_CODES).toContain(coerced.code);
    }
  });

  it('passes an existing TallyError through unchanged', () => {
    const original = new TallyError('INVALID_PARAMETERS', 'bad input');
    expect(TallyError.from(original)).toBe(original);
  });

  it('never leaks stack, cause or context to the client', () => {
    // `context` holds internal detail and `cause` can carry a parse failure over
    // real accounting data. Neither belongs in a client transcript.
    const error = new TallyError('TALLY_INVALID_RESPONSE', 'unreadable', {
      // Backslashes doubled so this is the Windows path it looks like. Written
      // singly they were read as the escapes \U, \s and \p and collapsed away,
      // leaving "at C:Userssecretpath.ts" — which still passed the assertions
      // below, because a leak check cannot fail on a string that no longer
      // contains the thing it is looking for.
      cause: new Error('at C:\\Users\\secret\\path.ts'),
      context: { ledger: 'Confidential Party Ltd', balance: '123456.78' },
    });

    const payload = error.toClientPayload();
    const serialised = JSON.stringify(payload);

    expect(Object.keys(payload.error).sort()).toEqual(['code', 'message', 'suggestion']);
    expect(serialised).not.toContain('secret');
    expect(serialised).not.toContain('Confidential Party Ltd');
    expect(serialised).not.toContain('123456.78');
    expect(serialised).not.toContain('stack');
  });
});
