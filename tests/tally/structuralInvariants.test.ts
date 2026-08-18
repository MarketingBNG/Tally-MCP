import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildLedgerListRequest,
  buildReportRequest,
  UNSCOPED,
  type CompanyScope,
} from '../../src/tally/requests.js';
import {
  normalizeLedgers,
  normalizeTrialBalance,
  normalizeVouchers,
  unreadablePayloadWarning,
} from '../../src/tally/normalize.js';
import { EMPTY_RESULT_CAVEAT } from '../../src/schemas/common.js';

/**
 * The three structural controls, as opposed to the two individual bug fixes.
 *
 * Both defects found on 17 Aug 2026 were the same shape: this server produced a
 * confident answer that was wrong or empty, and nothing in the system noticed —
 * a human did. Regression tests for those two bugs are necessary but do not
 * change that, because the next bug of the same family still gets in.
 *
 * These pin the controls that make the families unwriteable rather than merely
 * tested:
 *
 *   1. A request cannot be built without deciding its company scope.
 *   2. A payload that carried content cannot be reported as an empty result.
 *   3. No standing reassurance is emitted without pointing at its precondition.
 */

// ---------------------------------------------------------------------------
// 1. Company scope must be an explicit decision
// ---------------------------------------------------------------------------

describe('company scope cannot be forgotten', () => {
  it('emits SVCURRENTCOMPANY for a named company', () => {
    expect(buildReportRequest('Trial Balance', { company: 'Alpha Ltd' })).toContain(
      '<SVCURRENTCOMPANY>Alpha Ltd</SVCURRENTCOMPANY>'
    );
  });

  it('omits it only for an explicit UNSCOPED', () => {
    expect(buildReportRequest('Trial Balance', { company: UNSCOPED })).not.toContain(
      'SVCURRENTCOMPANY'
    );
  });

  it('throws rather than sending an undefined company name', () => {
    // The catastrophic case. `<SVCURRENTCOMPANY>undefined</SVCURRENTCOMPANY>` is
    // a NAME MISMATCH, and TallyPrime answers a mismatch from whichever company
    // happens to be loaded instead of erroring — so this would read another
    // entity's books and report them under the name that was asked for.
    const noScope = {} as unknown as { company: CompanyScope };
    expect(() => buildReportRequest('Trial Balance', noScope)).toThrow(/no company scope/);
    expect(() => buildLedgerListRequest(noScope)).toThrow(/no company scope/);
  });

  it('leaves no builder with a permissive default options object', () => {
    // The mechanism that allowed §2.8: `options: TallyRequestOptions = {}` on
    // every builder meant an unscoped call compiled. Only the company list may
    // default, because "which companies are open" has nothing to scope to.
    const source = readFileSync(join(process.cwd(), 'src/tally/requests.ts'), 'utf8');
    const defaults = [...source.matchAll(/options: TallyRequestOptions = ([^\n]*)/g)].map(
      (match) => match[1] ?? ''
    );

    for (const value of defaults) {
      expect(value).toContain('UNSCOPED');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. A populated payload is never an empty result
// ---------------------------------------------------------------------------

describe('a payload that carried content is never reported as empty', () => {
  const POPULATED_BUT_UNREADABLE = `<ENVELOPE><BODY><DATA>${'<MYSTERY>4200.00</MYSTERY>'.repeat(
    30
  )}</DATA></BODY></ENVELOPE>`;
  const GENUINELY_EMPTY = '<ENVELOPE></ENVELOPE>';

  it('says so directly, in words that forbid "none found"', () => {
    const warning = unreadablePayloadWarning(POPULATED_BUT_UNREADABLE, 0, 'the ledger masters');
    expect(warning).toBeDefined();
    expect(warning).toContain('UNREAD PAYLOAD');
    expect(warning).toContain('NOT an empty result');
  });

  it('stays silent when rows were actually read', () => {
    expect(unreadablePayloadWarning(POPULATED_BUT_UNREADABLE, 7, 'anything')).toBeUndefined();
  });

  it('stays silent on a genuinely empty envelope', () => {
    expect(unreadablePayloadWarning(GENUINELY_EMPTY, 0, 'anything')).toBeUndefined();
  });

  it.each([
    ['ledgers', (xml: string) => normalizeLedgers(xml, false, 'INR')],
    ['trial balance', (xml: string) => normalizeTrialBalance(xml, 'INR')],
    ['vouchers', (xml: string) => normalizeVouchers(xml, 'INR')],
  ])('is enforced by the %s normaliser, not just available to it', (_label, normalize) => {
    // The point of the invariant is that no parser can opt out. Each of these
    // matches its own tag vocabulary against an undocumented payload shape, so
    // each can be handed bytes it does not recognise.
    const { data, warnings } = normalize(POPULATED_BUT_UNREADABLE);
    expect(data).toHaveLength(0);
    expect(warnings.join(' ')).toContain('UNREAD PAYLOAD');
  });

  it('does not fire on an empty payload through a normaliser', () => {
    const { warnings } = normalizeLedgers(GENUINELY_EMPTY, false, 'INR');
    expect(warnings.join(' ')).not.toContain('UNREAD PAYLOAD');
  });
});

// ---------------------------------------------------------------------------
// 3. No unconditional reassurance
// ---------------------------------------------------------------------------

describe('standing reassurance points at its own precondition', () => {
  it('the shared caveat names the signal that overrides it', () => {
    expect(EMPTY_RESULT_CAVEAT).toContain('UNREAD PAYLOAD');
    expect(EMPTY_RESULT_CAVEAT).toContain('do not report "none found"');
  });

  /**
   * Files that tell the caller an empty result is genuine, WITHOUT the caveat,
   * because the claim is already gated on evidence at the point it is made.
   *
   * `bankReconciliation` is the one such case today: its note fires only under
   * `extracted.length === 0 && vouchers.length > 0`, so vouchers demonstrably
   * parsed and the absence of instrument detail is a fact about the books rather
   * than a possible parse failure. That is exactly the precondition the caveat
   * would otherwise supply, so requiring it here would be noise.
   *
   * Anything added to this list needs the same property: the reassurance must be
   * unreachable unless the payload was read successfully.
   */
  const CONDITIONAL_BY_CONSTRUCTION = ['bankReconciliation.ts'];

  it('every unconditional "a real answer" claim carries the caveat', () => {
    /*
     * The sentence that made the report defect persuasive was a tool
     * description telling the reader an empty result was fine — stated with no
     * precondition, so it applied even when the emptiness was a parse failure.
     *
     * This requires every tool file that makes the claim in a STRING LITERAL —
     * text that reaches the caller, as opposed to a comment about the history —
     * either to reference the caveat or to be listed above with a reason.
     *
     * It cannot judge wording, only that the claim is not left standing alone,
     * which is the property that actually failed. An earlier version of this
     * test matched on the phrases "that is" and "which is" and passed only
     * because the one uncaveated claim happens to begin "This is" — a check that
     * would have missed a new violation phrased any other way.
     */
    const dir = join(process.cwd(), 'src/tools');
    const offenders: string[] = [];

    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      if (CONDITIONAL_BY_CONSTRUCTION.includes(file)) continue;

      const source = readFileSync(join(dir, file), 'utf8');
      const inStringLiteral = /'[^']*is a real answer[^']*'/.test(source);
      if (inStringLiteral && !source.includes('EMPTY_RESULT_CAVEAT')) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });

  it('actually catches an uncaveated claim', () => {
    // Proves the check above bites, rather than passing because its pattern
    // failed to match anything. Without this, a lint that matches nothing looks
    // identical to a codebase with no violations.
    const violating = "const NOTE = 'Returning nothing is a real answer here.';";
    expect(/'[^']*is a real answer[^']*'/.test(violating)).toBe(true);
    expect(violating.includes('EMPTY_RESULT_CAVEAT')).toBe(false);
  });
});
