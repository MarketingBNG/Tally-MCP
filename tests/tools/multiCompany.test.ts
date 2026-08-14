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

/**
 * `tally_get_statement` with `companies` — one statement across several companies.
 *
 * The plan blocked this tool for a specific reason: with the company-name
 * handling as it was, it could return ONE company's figures N times, labelled as
 * N different companies — the failure a group comparison would never survive.
 * That risk was real, though for a different reason than first thought (the
 * envelope attribution bug, not Tally's name matching), so the test the plan
 * asked for is the first one below: the figures must actually differ.
 *
 * The other three tests are the ones the live data forced. Three companies open
 * at once run a German calendar year and two April years, and report `$`, `?`
 * and `?` — so a defaulted period compares different months, and a subtraction
 * across columns crosses currencies.
 */

let mock: MockTallyServer;
let port: number;

const THREE_COMPANIES = `<ENVELOPE><BODY><DATA><COLLECTION>
  <COMPANY NAME="AGBV Nutrition GmbH" RESERVEDNAME="">
    <STARTINGFROM TYPE="Date">20230101</STARTINGFROM>
    <ENDINGAT TYPE="Date">20260731</ENDINGAT>
    <NAME TYPE="String">AGBV Nutrition GmbH</NAME>
    <CURRENCYNAME TYPE="String">?</CURRENCYNAME>
    <COUNTRYNAME TYPE="String">Germany</COUNTRYNAME>
  </COMPANY>
  <COMPANY NAME="AgEx Pharma LLC" RESERVEDNAME="">
    <STARTINGFROM TYPE="Date">20250401</STARTINGFROM>
    <ENDINGAT TYPE="Date">20260331</ENDINGAT>
    <NAME TYPE="String">AgEx Pharma LLC</NAME>
    <CURRENCYNAME TYPE="String">$</CURRENCYNAME>
    <COUNTRYNAME TYPE="String">United States of America</COUNTRYNAME>
  </COMPANY>
</COLLECTION></DATA></BODY></ENVELOPE>`;

/** Two companies that DO share a currency, so differences are computable. */
const TWO_DOLLAR_COMPANIES = THREE_COMPANIES.replace(
  '<CURRENCYNAME TYPE="String">?</CURRENCYNAME>',
  '<CURRENCYNAME TYPE="String">$</CURRENCYNAME>'
);

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

function build(): ToolRegistry {
  const registry = createToolRegistry();
  registerReportTools(registry.server, makeDeps(port));
  return registry;
}

const BOTH = ['AGBV Nutrition GmbH', 'AgEx Pharma LLC'];
const PERIOD = { fromDate: '2025-04-01', toDate: '2025-10-31' };

beforeAll(async () => {
  mock = new MockTallyServer();
  port = await mock.start();
});

afterAll(async () => {
  await mock.stop();
});

beforeEach(() => {
  mock.reset();
  mock.onBodyContaining('List of Companies', { body: THREE_COMPANIES });
  mock.onBodyContaining('<ID>Currencies</ID>', {
    body: '<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>',
  });
  mock.onBodyContaining('<ID>Ledgers</ID>', {
    body: '<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>',
  });
});

describe('the figures actually differ per company', () => {
  it('returns each company own figures, not one company repeated', async () => {
    // THE test the plan demanded before this tool could ship. A group
    // comparison showing the same numbers under two names is worse than no
    // comparison at all, because it looks like a finding.
    let call = 0;
    const amounts = ['-1000', '-2000'];
    mock.onBodyContaining('Trial Balance', () => ({
      body: trialBalance([['Sales', amounts[call++] ?? '-0']]),
    }));

    const result = await callToolOk(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      companies: BOTH,
      ...PERIOD,
    });

    const rows = (
      result.comparison as { rows: { key: string; figures: Record<string, { amount: string }[]> }[] }
    ).rows;
    const sales = rows.find((row) => row.key === 'Sales');

    expect(sales?.figures.debit?.map((m) => m.amount)).toEqual(['-1000', '-2000']);
  });

  it('sends a separate request per company, each naming that company', async () => {
    mock.onBodyContaining('Trial Balance', { body: trialBalance([['Sales', '-1']]) });

    const result = await callToolOk(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      companies: BOTH,
      ...PERIOD,
    });

    const named = (result.companies as { company: string }[]).map((entry) => entry.company);
    expect(named).toEqual(BOTH);
  });

  it('reports each company own currency alongside its column', async () => {
    mock.onBodyContaining('Trial Balance', { body: trialBalance([['Sales', '-1']]) });

    const result = await callToolOk(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      companies: BOTH,
      ...PERIOD,
    });

    const currencies = (result.companies as { currency: string }[]).map((e) => e.currency);
    expect(currencies).toEqual(['unknown', '$']);
  });
});

describe('what it refuses, and why', () => {
  it('refuses a defaulted period, because the book years differ', async () => {
    // AGBV runs a calendar year and AgEx an April year. Defaulting would put
    // different months in adjacent columns under one heading.
    const error = await callToolError(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      companies: BOTH,
    });

    expect(error.code).toBe('INVALID_DATE_RANGE');
    expect(error.suggestion).toContain('different book years');
  });

  it('refuses an end date TallyPrime will not honour', async () => {
    // Worse here than for one statement: each company would accumulate to the
    // end of ITS OWN last book year, and those differ — so the columns would
    // cover different spans while appearing to cover one.
    const error = await callToolError(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      companies: BOTH,
      fromDate: '2025-04-01',
      toDate: '2025-09-30',
    });

    expect(error.code).toBe('TALLY_UNSUPPORTED_OPERATION');
    expect(error.message).toContain('ITS OWN last book year');
  });

  it('refuses a company that is not open in TallyPrime', async () => {
    const error = await callToolError(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      companies: ['AgEx Pharma LLC', 'Not Open Ltd'],
      ...PERIOD,
    });

    expect(error.code).toBe('TALLY_COMPANY_NOT_LOADED');
  });

  it('refuses the same company listed twice', async () => {
    const error = await callToolError(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      companies: ['AgEx Pharma LLC', 'agex pharma llc'],
      ...PERIOD,
    });

    expect(error.code).toBe('INVALID_PARAMETERS');
  });

  it('refuses companies mixed with periods', async () => {
    const error = await callToolError(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      companies: BOTH,
      periods: [
        { fromDate: '2025-04-01', toDate: '2025-05-31' },
        { fromDate: '2025-06-01', toDate: '2025-07-31' },
      ],
    });

    expect(error.code).toBe('INVALID_PARAMETERS');
  });
});

describe('differences are computed only within one currency', () => {
  it('computes nothing across companies reporting different currencies', async () => {
    mock.onBodyContaining('Trial Balance', { body: trialBalance([['Sales', '-1000']]) });

    const result = await callToolOk(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      companies: BOTH,
      ...PERIOD,
    });

    const comparison = result.comparison as {
      differencesComputed: boolean;
      rows: { movements: Record<string, unknown[]> }[];
    };

    expect(comparison.differencesComputed).toBe(false);
    expect(Object.keys(comparison.rows[0]?.movements ?? {})).toHaveLength(0);
    expect((result.warnings as string[]).join(' ')).toContain('NO DIFFERENCES BETWEEN COMPANIES');
  });

  it('computes differences when every company shares a currency', async () => {
    mock.reset();
    mock.onBodyContaining('List of Companies', { body: TWO_DOLLAR_COMPANIES });
    mock.onBodyContaining('<ID>Currencies</ID>', {
      body: '<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>',
    });
    mock.onBodyContaining('<ID>Ledgers</ID>', {
      body: '<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>',
    });
    let call = 0;
    const amounts = ['-1000', '-2500'];
    mock.onBodyContaining('Trial Balance', () => ({
      body: trialBalance([['Sales', amounts[call++] ?? '-0']]),
    }));

    const result = await callToolOk(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      companies: BOTH,
      ...PERIOD,
    });

    const comparison = result.comparison as {
      differencesComputed: boolean;
      rows: { movements: Record<string, { change: { amount: string } | null }[]> }[];
    };

    expect(comparison.differencesComputed).toBe(true);
    expect(comparison.rows[0]?.movements.debit?.[0]?.change?.amount).toBe('-1500');
  });

  it('never calls a cross-company difference a movement over time', async () => {
    mock.reset();
    mock.onBodyContaining('List of Companies', { body: TWO_DOLLAR_COMPANIES });
    mock.onBodyContaining('<ID>Currencies</ID>', {
      body: '<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>',
    });
    mock.onBodyContaining('<ID>Ledgers</ID>', {
      body: '<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>',
    });
    mock.onBodyContaining('Trial Balance', { body: trialBalance([['Sales', '-1']]) });

    const result = await callToolOk(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      companies: BOTH,
      ...PERIOD,
    });

    // These are two separate legal entities, not one entity over time.
    expect((result.warnings as string[]).join(' ')).toContain('not a movement over time');
  });
});
