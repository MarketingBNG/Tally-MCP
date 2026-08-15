import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolOk,
  createToolRegistry,
  makeDeps,
  type ToolRegistry,
} from './harness.js';
import { registerReportTools } from '../../src/tools/reports.js';
import { isStandingBoilerplate, trimWarnings } from '../../src/tools/verbosity.js';
import { rowIsNil } from '../../src/tools/statementComparison.js';

/**
 * `verbosity: "summary"`.
 *
 * The win is real — a full chart of accounts is mostly nil rows — but the risk
 * is the same one this codebase is built around: a shorter response that has
 * quietly lost the line saying a figure is wrong. So every test here is about
 * what summary mode must NOT do.
 */

let mock: MockTallyServer;
let port: number;

const ONE_COMPANY = `<ENVELOPE><BODY><DATA><COLLECTION>
  <COMPANY NAME="Alpha Ltd" RESERVEDNAME="">
    <STARTINGFROM TYPE="Date">20250401</STARTINGFROM>
    <ENDINGAT TYPE="Date">20260331</ENDINGAT>
    <NAME TYPE="String">Alpha Ltd</NAME>
    <CURRENCYNAME TYPE="String">$</CURRENCYNAME>
    <COUNTRYNAME TYPE="String">United States of America</COUNTRYNAME>
  </COMPANY>
</COLLECTION></DATA></BODY></ENVELOPE>`;

const EMPTY_COLLECTION = '<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>';

/** Two real rows, three nil ones, and one whose amount cannot be parsed. */
function mixedTrialBalance(): string {
  const rows: [string, string][] = [
    ['Sales', '-1000'],
    ['Dormant One', '0'],
    ['Purchases', '250.50'],
    ['Dormant Two', '0.00'],
    ['Dormant Three', '0'],
    ['Unreadable', 'n/a'],
  ];

  return (
    '<ENVELOPE>' +
    rows
      .map(
        ([name, debit]) =>
          `<DSPACCNAME><DSPDISPNAME>${name}</DSPDISPNAME></DSPACCNAME>` +
          `<DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA>${debit}</DSPCLDRAMTA></DSPCLDRAMT></DSPACCINFO>`
      )
      .join('') +
    '</ENVELOPE>'
  );
}

function build(): ToolRegistry {
  const registry = createToolRegistry();
  registerReportTools(registry.server, makeDeps(port));
  return registry;
}

const PERIOD = { fromDate: '2025-04-01', toDate: '2026-03-31' };

interface Row {
  name?: string;
}

async function statement(verbosity?: 'full' | 'summary'): Promise<Record<string, unknown>> {
  return callToolOk(build(), 'tally_get_statement', {
    statement: 'trial_balance',
    company: 'Alpha Ltd',
    ...(verbosity === undefined ? {} : { verbosity }),
    ...PERIOD,
  });
}

function namesOn(result: Record<string, unknown>): string[] {
  return (result.rows as Row[]).map((row) => row.name ?? '');
}

beforeAll(async () => {
  mock = new MockTallyServer();
  port = await mock.start();
});

afterAll(async () => {
  await mock.stop();
});

beforeEach(() => {
  mock.reset();
  mock.onBodyContaining('List of Companies', { body: ONE_COMPANY });
  mock.onBodyContaining('<ID>Currencies</ID>', { body: EMPTY_COLLECTION });
  mock.onBodyContaining('<ID>Ledgers</ID>', { body: EMPTY_COLLECTION });
  mock.onBodyContaining('Trial Balance', { body: mixedTrialBalance() });
});

describe('a statement at summary verbosity', () => {
  it('omits rows whose every figure is nil, and counts what it omitted', async () => {
    const summary = await statement('summary');
    const names = namesOn(summary);

    expect(names).not.toContain('Dormant One');
    expect(names).not.toContain('Dormant Two');
    expect(names).not.toContain('Dormant Three');
    expect(summary.nilRowsOmitted).toBe(3);
    // The total population is still stated, so the reader knows what was cut from.
    expect(summary.rowsInStatement).toBe(6);
  });

  it('keeps every row that carries a figure', async () => {
    const names = namesOn(await statement('summary'));

    expect(names).toContain('Sales');
    expect(names).toContain('Purchases');
  });

  it('keeps a row whose amount could not be read, rather than treating it as zero', async () => {
    // An unreadable figure is a gap in the data. Dropping it would hide that
    // gap behind an apparently complete statement — the worst outcome here.
    expect(namesOn(await statement('summary'))).toContain('Unreadable');
  });

  it('returns the whole statement at full verbosity, which is the default', async () => {
    const full = await statement();
    const explicit = await statement('full');

    expect(namesOn(full)).toHaveLength(6);
    expect(namesOn(explicit)).toHaveLength(6);
    // Nothing about the summary shape leaks into a full response.
    expect(full.nilRowsOmitted).toBeUndefined();
    expect(full.verbosity).toBeUndefined();
  });
});

describe('rowIsNil', () => {
  it('is true when every figure present is zero', () => {
    expect(
      rowIsNil({ debit: { amount: '0', currency: '$' }, credit: { amount: '0.00', currency: '$' } })
    ).toBe(true);
    // The ordinary shape: one column applies, and it is zero.
    expect(rowIsNil({ debit: { amount: '0', currency: '$' }, credit: null })).toBe(true);
  });

  it('is false when any figure is real', () => {
    expect(
      rowIsNil({ debit: { amount: '1', currency: '$' }, credit: { amount: '0', currency: '$' } })
    ).toBe(false);
    // An unparseable amount is not a zero.
    expect(rowIsNil({ debit: { amount: 'n/a', currency: '$' }, credit: null })).toBe(false);
  });

  it('needs at least one real zero, so nulls alone never drop a row', () => {
    // All-null means no figure was produced at all. The normaliser warns about
    // that separately, but the row must not be dropped on nulls alone.
    expect(rowIsNil({ debit: null, credit: null })).toBe(false);
    // A row with no figures at all is not a nil row — there was nothing to test.
    expect(rowIsNil({})).toBe(false);
  });
});

describe('the warning trimmer fails safe', () => {
  it('never drops a warning it does not explicitly recognise', () => {
    // The property that matters most: a warning written tomorrow survives.
    const novel = 'SOMETHING NEW AND ALARMING happened to these figures.';
    const trimmed = trimWarnings('summary', [novel]);

    expect(trimmed.warnings).toEqual([novel]);
    expect(trimmed.omitted).toBe(0);
  });

  it('drops registered boilerplate and says how much it dropped', () => {
    const boilerplate = 'Read-only: nothing here can modify TallyPrime.';
    const real = 'This ledger does not roll forward.';
    const trimmed = trimWarnings('summary', [boilerplate, real]);

    expect(trimmed.warnings).toEqual([real]);
    expect(trimmed.omitted).toBe(1);
    expect(trimmed.note).toMatch(/omitted/i);
  });

  it('changes nothing at full verbosity', () => {
    const warnings = ['Read-only: nothing here can modify TallyPrime.', 'Anything at all.'];
    expect(trimWarnings('full', warnings).warnings).toEqual(warnings);
    expect(trimWarnings('full', warnings).omitted).toBe(0);
  });

  it('recognises boilerplate only by its full distinctive text', () => {
    expect(isStandingBoilerplate('Read-only: nothing here can modify TallyPrime.')).toBe(true);
    expect(isStandingBoilerplate('read-only')).toBe(false);
  });
});
