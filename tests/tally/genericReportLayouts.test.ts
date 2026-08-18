import { describe, it, expect } from 'vitest';
import { normalizeGenericReport } from '../../src/tally/normalize.js';

/**
 * The three row layouts TallyPrime's report views actually use.
 *
 * THE DEFECT THESE PIN. `normalizeGenericReport` read only
 * `DSPACCNAME`/`DSPACCINFO` — the shape `Negative Ledgers` uses, and the report
 * the allowlist was verified against. Measured live 2026-08-17 against MUDALS
 * TECHNOLOGIES, three other allowlisted reports use different vocabularies
 * entirely and every one of them parsed to ZERO rows:
 *
 *   Journal Register  2,098 bytes  DSPPERIOD / DSPACCINFO   -> 0 rows
 *   Sales Register    2,817 bytes  DSPPERIOD / DSPACCINFO   -> 0 rows
 *   Ratio Analysis    1,677 bytes  RATIONAME / RATIOVALUE   -> 0 rows
 *
 * The tool then appended its standing note that an empty result is a real
 * answer on an exception report. So it did not just lose the figures, it
 * explained the loss as a clean result — on a sales register, "this company
 * records no sales". That is the worst failure mode this codebase recognises:
 * a confident, plausible, wrong answer.
 *
 * The last group is the important one. A payload this parser cannot read must
 * never again be reported as an empty one.
 */

/** Register shape: one row per month, keyed by period rather than account. */
const REGISTER = [
  '<ENVELOPE>',
  '<DSPPERIOD>1-Apr-2026 to 30-Apr-2026</DSPPERIOD>',
  '<DSPACCINFO><DSPDRAMT><DSPDRAMTA>125000.00</DSPDRAMTA></DSPDRAMT>',
  '<DSPCRAMT><DSPCRAMTA>-125000.00</DSPCRAMTA></DSPCRAMT></DSPACCINFO>',
  '<DSPPERIOD>1-May-2026 to 31-May-2026</DSPPERIOD>',
  '<DSPACCINFO><DSPDRAMT><DSPDRAMTA>98000.50</DSPDRAMTA></DSPDRAMT>',
  '<DSPCRAMT><DSPCRAMTA>-98000.50</DSPCRAMTA></DSPCRAMT></DSPACCINFO>',
  '</ENVELOPE>',
].join('');

/** Ratio Analysis: flat name/value pairs, no amount block at all. */
const RATIOS = [
  '<ENVELOPE>',
  '<RATIONAME>Current Ratio</RATIONAME><RATIOVALUE>1.42 : 1</RATIOVALUE>',
  '<RATIONAME>Quick Ratio</RATIONAME><RATIOVALUE>0.87 : 1</RATIOVALUE>',
  '</ENVELOPE>',
].join('');

/** The originally-supported shape, which must keep working unchanged. */
const PER_ACCOUNT = [
  '<ENVELOPE>',
  '<DSPACCNAME><DSPDISPNAME>Petty Cash</DSPDISPNAME></DSPACCNAME>',
  '<DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA>-4200.00</DSPCLDRAMTA></DSPCLDRAMT></DSPACCINFO>',
  '</ENVELOPE>',
].join('');

const EMPTY = '<ENVELOPE></ENVELOPE>';

describe('per-account layout still works', () => {
  it('reads DSPACCNAME/DSPACCINFO rows as before', () => {
    const { data } = normalizeGenericReport(PER_ACCOUNT, 'Negative Ledgers');
    expect(data).toHaveLength(1);
    expect(data[0]?.name).toBe('Petty Cash');
    expect(data[0]?.amounts.DSPCLDRAMTA).toBe('-4200.00');
  });

  it('says nothing about layout when it is the expected one', () => {
    const { warnings } = normalizeGenericReport(PER_ACCOUNT, 'Negative Ledgers');
    expect(warnings.join(' ')).not.toContain('row layout');
  });
});

describe('register layout (DSPPERIOD/DSPACCINFO)', () => {
  it('reads rows that previously parsed to nothing', () => {
    const { data } = normalizeGenericReport(REGISTER, 'Journal Register');
    expect(data).toHaveLength(2);
    expect(data[0]?.name).toBe('1-Apr-2026 to 30-Apr-2026');
    expect(data[0]?.amounts.DSPDRAMTA).toBe('125000.00');
    expect(data[1]?.amounts.DSPCRAMTA).toBe('-98000.50');
  });

  it('warns that each row is a period, not an account', () => {
    // Without this the rows read as ledger balances, which is a wrong meaning
    // attached to right numbers.
    const { warnings } = normalizeGenericReport(REGISTER, 'Journal Register');
    const text = warnings.join(' ');
    expect(text).toContain('Each row is a PERIOD');
    expect(text).toContain('Do not read these rows as ledger balances');
  });
});

describe('ratio layout (RATIONAME/RATIOVALUE)', () => {
  it('reads each ratio and its value', () => {
    const { data } = normalizeGenericReport(RATIOS, 'Ratio Analysis');
    expect(data).toHaveLength(2);
    expect(data[0]?.name).toBe('Current Ratio');
    expect(data[0]?.amounts.RATIOVALUE).toBe('1.42 : 1');
    expect(data[1]?.amounts.RATIOVALUE).toBe('0.87 : 1');
  });

  it("keeps TallyPrime's own tag name rather than inventing a column", () => {
    const { data } = normalizeGenericReport(RATIOS, 'Ratio Analysis');
    expect(Object.keys(data[0]?.amounts ?? {})).toEqual(['RATIOVALUE']);
  });

  it('warns that there are no debit/credit columns to read', () => {
    const { warnings } = normalizeGenericReport(RATIOS, 'Ratio Analysis');
    expect(warnings.join(' ')).toContain('RATIOVALUE');
  });
});

describe('an unreadable payload is never reported as an empty one', () => {
  const UNKNOWN = `<ENVELOPE>${'<SOMETAG>1234.00</SOMETAG>'.repeat(20)}</ENVELOPE>`;

  it('says the layout was unrecognised when bytes came back', () => {
    // THE LOAD-BEARING TEST. This is the exact confusion that made the original
    // defect invisible: real data, zero rows, and a note saying that was fine.
    const { data, warnings } = normalizeGenericReport(UNKNOWN, 'Some Report');
    expect(data).toHaveLength(0);
    const text = warnings.join(' ');
    expect(text).toContain('UNRECOGNISED ROW LAYOUT');
    expect(text).toContain('NOT an empty report');
    expect(text).not.toContain('that is a real answer');
  });

  it('still calls a genuinely empty envelope empty', () => {
    const { data, warnings } = normalizeGenericReport(EMPTY, 'Negative Stock');
    expect(data).toHaveLength(0);
    const text = warnings.join(' ');
    expect(text).toContain('returned no rows');
    expect(text).not.toContain('UNRECOGNISED');
  });
});
