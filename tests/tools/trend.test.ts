import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolError,
  callToolOk,
  createToolRegistry,
  makeDeps,
  type ToolRegistry,
} from './harness.js';
import { registerReportTools } from '../../src/tools/reports.js';
import { buildTrend } from '../../src/tools/statementComparison.js';

/**
 * `tally_get_statement` with `periods` — one statement across N periods.
 *
 * Two things are under test, and the second is the one that would do damage if
 * it broke: the arithmetic, and the refusal.
 *
 * A trend is the output most likely to be read as a SHAPE — five figures and a
 * direction — and quoted without its caveats. So the two rules from the
 * two-period comparison have to survive being generalised: a row missing from a
 * period is null and never zero, and a name that is ambiguous anywhere is not
 * tracked at all.
 */

let mock: MockTallyServer;
let port: number;

/** A trial balance with the rows and amounts given. */
function trialBalance(rows: [string, string][]): string {
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

const COMPANY = `<ENVELOPE><BODY><DATA><COLLECTION>
  <COMPANY NAME="AgEx Pharma LLC" RESERVEDNAME="">
    <STARTINGFROM TYPE="Date">20250401</STARTINGFROM>
    <ENDINGAT TYPE="Date">20260331</ENDINGAT>
    <NAME TYPE="String">AgEx Pharma LLC</NAME>
    <CURRENCYNAME TYPE="String">$</CURRENCYNAME>
    <COUNTRYNAME TYPE="String">United States of America</COUNTRYNAME>
  </COMPANY>
</COLLECTION></DATA></BODY></ENVELOPE>`;

function build(): ToolRegistry {
  const registry = createToolRegistry();
  registerReportTools(registry.server, makeDeps(port));
  return registry;
}

/** Three periods, all ending on a 31st so the end dates bind. */
const THREE_PERIODS = [
  { fromDate: '2025-04-01', toDate: '2025-05-31' },
  { fromDate: '2025-06-01', toDate: '2025-07-31' },
  { fromDate: '2025-08-01', toDate: '2025-10-31' },
];

beforeAll(async () => {
  mock = new MockTallyServer();
  port = await mock.start();
});

afterAll(async () => {
  await mock.stop();
});

beforeEach(() => {
  mock.reset();
  mock.onBodyContaining('List of Companies', { body: COMPANY });
  mock.onBodyContaining('<ID>Currencies</ID>', {
    body: '<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>',
  });
  mock.onBodyContaining('<ID>Ledgers</ID>', {
    body: '<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>',
  });
});

describe('the trend refuses periods TallyPrime will not honour', () => {
  it('refuses when any end date is not a 31st', async () => {
    // The single most important behaviour here. Tally ignores an end date that
    // is not a 31st and accumulates to a fixed endpoint instead — so every
    // period would share that endpoint, and the movements would be differences
    // between overlapping accumulations. Plausible-looking, and wrong.
    mock.onBodyContaining('Trial Balance', { body: trialBalance([['Sales', '-100']]) });

    const error = await callToolError(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      periods: [
        { fromDate: '2025-04-01', toDate: '2025-06-30' },
        { fromDate: '2025-07-01', toDate: '2025-09-30' },
      ],
    });

    expect(error.code).toBe('TALLY_UNSUPPORTED_OPERATION');
    expect(error.message).toContain('overlapping accumulations');
  });

  it('names the nearest binding date for each offending period', async () => {
    const error = await callToolError(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      periods: [
        { fromDate: '2025-04-01', toDate: '2025-06-30' },
        { fromDate: '2025-07-01', toDate: '2025-09-30' },
      ],
    });

    // An error that only says "no" costs another round trip to act on.
    expect(error.suggestion).toContain('2025-06-30 →');
    expect(error.suggestion).toContain('2025-09-30 →');
  });

  it('refuses before spending any request on Tally', async () => {
    // N report-class fetches is the most expensive thing this server does.
    // Validation must never cost them.
    mock.reset();
    mock.onBodyContaining('List of Companies', { body: COMPANY });

    const error = await callToolError(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      periods: [
        { fromDate: '2025-04-01', toDate: '2025-06-30' },
        { fromDate: '2025-07-01', toDate: '2025-09-30' },
      ],
    });

    expect(error.code).toBe('TALLY_UNSUPPORTED_OPERATION');
  });

  it('refuses periods mixed with the single-period parameters', async () => {
    const error = await callToolError(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      fromDate: '2025-04-01',
      toDate: '2025-05-31',
      periods: THREE_PERIODS,
    });

    expect(error.code).toBe('INVALID_PARAMETERS');
  });
});

describe('the trend tracks rows across the series', () => {
  it('returns one figure per period, in the order given', async () => {
    let call = 0;
    const amounts = ['-100', '-250', '-400'];
    mock.onBodyContaining('Trial Balance', () => ({
      body: trialBalance([['Sales', amounts[call++] ?? '-0']]),
    }));

    const result = await callToolOk(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      periods: THREE_PERIODS,
    });

    const rows = (result.trend as { rows: { key: string; figures: Record<string, unknown[]> }[] })
      .rows;
    const sales = rows.find((row) => row.key === 'Sales');
    expect(sales?.figures.debit).toHaveLength(3);
    expect((sales?.figures.debit as { amount: string }[]).map((m) => m.amount)).toEqual([
      '-100',
      '-250',
      '-400',
    ]);
  });

  it('computes movement between consecutive periods, not against the first', async () => {
    let call = 0;
    const amounts = ['-100', '-250', '-400'];
    mock.onBodyContaining('Trial Balance', () => ({
      body: trialBalance([['Sales', amounts[call++] ?? '-0']]),
    }));

    const result = await callToolOk(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      periods: THREE_PERIODS,
    });

    const rows = (
      result.trend as {
        rows: { key: string; movements: Record<string, { change: { amount: string } | null }[]> }[];
      }
    ).rows;
    const movements = rows.find((row) => row.key === 'Sales')?.movements.debit;

    // Two movements for three periods, each against the one before it.
    expect(movements).toHaveLength(2);
    expect(movements?.[0]?.change?.amount).toBe('-150');
    expect(movements?.[1]?.change?.amount).toBe('-150');
  });

  it('keeps the periods in the order given rather than sorting them', async () => {
    // "Q4 against Q1" is a real question, and sorting would relabel every
    // movement without saying so.
    mock.onBodyContaining('Trial Balance', { body: trialBalance([['Sales', '-100']]) });

    const result = await callToolOk(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      periods: [
        { fromDate: '2025-08-01', toDate: '2025-10-31' },
        { fromDate: '2025-04-01', toDate: '2025-05-31' },
      ],
    });

    const periods = result.periods as { fromDate: string }[];
    expect(periods.map((p) => p.fromDate)).toEqual(['2025-08-01', '2025-04-01']);
  });
});

describe('the two rules that must survive being generalised', () => {
  it('reports an absent row as null, never zero, and says which periods it was in', () => {
    // The rule that matters most in a trend. A series read as a shape turns a
    // null into "it fell to nothing" when TallyPrime simply did not report the
    // row — an absence of data read as a fact about the business.
    const trend = buildTrend(
      [
        [{ name: 'Sales', debit: { amount: '-100', currency: '$' }, credit: null }],
        [{ name: 'Other', debit: { amount: '-5', currency: '$' }, credit: null }],
        [{ name: 'Sales', debit: { amount: '-300', currency: '$' }, credit: null }],
      ],
      {
        keyOf: (row) => (row as { name: string }).name,
        figuresOf: (row) => ({
          debit: (row as { debit: null }).debit,
          credit: (row as { credit: null }).credit,
        }),
        keyLabel: 'group',
      }
    );

    const sales = trend.rows.find((row) => row.key === 'Sales');
    expect(sales?.figures.debit?.[1]).toBeNull();
    expect(sales?.presentIn).toEqual([0, 2]);
    expect(trend.warnings.join(' ')).toContain('NOT that the figure');
  });

  it('computes no movement across a null rather than treating it as zero', () => {
    const trend = buildTrend(
      [
        [{ name: 'Sales', debit: { amount: '-100', currency: '$' } }],
        [{ name: 'Other', debit: { amount: '-5', currency: '$' } }],
      ],
      {
        keyOf: (row) => (row as { name: string }).name,
        figuresOf: (row) => ({ debit: (row as { debit: null }).debit }),
        keyLabel: 'group',
      }
    );

    // -100 to absent is NOT a movement of +100.
    const sales = trend.rows.find((row) => row.key === 'Sales');
    expect(sales?.movements.debit?.[0]?.change).toBeNull();
  });

  it('excludes a name that is ambiguous in ANY period from the whole series', () => {
    // Not just from the period where it repeated. Tracking it elsewhere and
    // dropping it in one place produces a hole that reads as missing data
    // rather than as missing certainty.
    const trend = buildTrend(
      [
        [
          { name: 'Sales', debit: { amount: '-100', currency: '$' } },
          { name: 'Sales', debit: { amount: '-50', currency: '$' } },
        ],
        [{ name: 'Sales', debit: { amount: '-300', currency: '$' } }],
      ],
      {
        keyOf: (row) => (row as { name: string }).name,
        figuresOf: (row) => ({ debit: (row as { debit: null }).debit }),
        keyLabel: 'group',
      }
    );

    expect(trend.rows.find((row) => row.key === 'Sales')).toBeUndefined();
    expect(trend.unpaired.ambiguous).toEqual(['sales']);
    expect(trend.warnings.join(' ')).toContain('appeared more than once');
  });

  it('takes the union of columns across periods rather than the first period only', () => {
    // A statement can report a column in one period and omit it in another.
    // Restricting to the first period's columns would drop a real figure.
    const trend = buildTrend(
      [
        [{ name: 'Sales', debit: { amount: '-100', currency: '$' }, credit: null }],
        [{ name: 'Sales', debit: null, credit: { amount: '20', currency: '$' } }],
      ],
      {
        keyOf: (row) => (row as { name: string }).name,
        figuresOf: (row) => {
          const typed = row as { debit: null; credit?: null };
          return { debit: typed.debit, ...(typed.credit === undefined ? {} : { credit: typed.credit }) };
        },
        keyLabel: 'group',
      }
    );

    const sales = trend.rows.find((row) => row.key === 'Sales');
    expect(Object.keys(sales?.figures ?? {}).sort()).toEqual(['credit', 'debit']);
  });
});
