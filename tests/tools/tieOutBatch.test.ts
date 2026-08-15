import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolError,
  callToolOk,
  createToolRegistry,
  makeDeps,
  type ToolRegistry,
} from './harness.js';
import { registerTieOutTools } from '../../src/tools/tieOut.js';
import type { Finding } from '../../src/tools/findings.js';

/**
 * `tally_check_tie_out` across several companies, with typed findings and a
 * summary verbosity.
 *
 * Three things are being protected here, and they are the three that would do
 * real damage if they broke:
 *
 * 1. A batch must never report a pass while one company is out. A gate that
 *    passes when something failed is worse than no gate.
 * 2. Findings must carry an explicit severity. The whole point is that a
 *    consumer can tell an exception from an FYI without reading prose.
 * 3. `verbosity: "summary"` must never drop a finding. It may only drop
 *    explanation, and it must say how much it dropped.
 */

let mock: MockTallyServer;
let port: number;

const TWO_COMPANIES = `<ENVELOPE><BODY><DATA><COLLECTION>
  <COMPANY NAME="Alpha Ltd" RESERVEDNAME="">
    <STARTINGFROM TYPE="Date">20250401</STARTINGFROM>
    <ENDINGAT TYPE="Date">20260331</ENDINGAT>
    <NAME TYPE="String">Alpha Ltd</NAME>
    <CURRENCYNAME TYPE="String">$</CURRENCYNAME>
    <COUNTRYNAME TYPE="String">United States of America</COUNTRYNAME>
  </COMPANY>
  <COMPANY NAME="Beta Ltd" RESERVEDNAME="">
    <STARTINGFROM TYPE="Date">20250401</STARTINGFROM>
    <ENDINGAT TYPE="Date">20260331</ENDINGAT>
    <NAME TYPE="String">Beta Ltd</NAME>
    <CURRENCYNAME TYPE="String">$</CURRENCYNAME>
    <COUNTRYNAME TYPE="String">United States of America</COUNTRYNAME>
  </COMPANY>
</COLLECTION></DATA></BODY></ENVELOPE>`;

const EMPTY_COLLECTION = '<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>';

/** A ledger that will not roll forward: opening 100, no movements, closing 250. */
const BROKEN_LEDGER = `<ENVELOPE><BODY><DATA><COLLECTION>
  <LEDGER NAME="Suspense" RESERVEDNAME="">
    <NAME TYPE="String">Suspense</NAME>
    <PARENT TYPE="String">Current Assets</PARENT>
    <OPENINGBALANCE TYPE="Amount">-100.00</OPENINGBALANCE>
    <CLOSINGBALANCE TYPE="Amount">-250.00</CLOSINGBALANCE>
  </LEDGER>
</COLLECTION></DATA></BODY></ENVELOPE>`;

const GROUPS = `<ENVELOPE><BODY><DATA><COLLECTION>
  <GROUP NAME="Current Assets" RESERVEDNAME="">
    <NAME TYPE="String">Current Assets</NAME>
    <PARENT TYPE="String"></PARENT>
    <ISREVENUE TYPE="Logical">No</ISREVENUE>
    <ISDEEMEDPOSITIVE TYPE="Logical">Yes</ISDEEMEDPOSITIVE>
  </GROUP>
</COLLECTION></DATA></BODY></ENVELOPE>`;

function build(): ToolRegistry {
  const registry = createToolRegistry();
  registerTieOutTools(registry.server, makeDeps(port));
  return registry;
}

const PERIOD = { fromDate: '2025-04-01', toDate: '2026-03-31' };

interface PerCompany {
  company: string;
  passed: boolean;
  exceptions: number;
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
  mock.onBodyContaining('List of Companies', { body: TWO_COMPANIES });
  mock.onBodyContaining('<ID>Currencies</ID>', { body: EMPTY_COLLECTION });
  mock.onBodyContaining('<ID>Groups</ID>', { body: GROUPS });
  mock.onBodyContaining('<ID>Ledgers</ID>', { body: EMPTY_COLLECTION });
  mock.onBodyContaining('<TYPE>Voucher</TYPE>', { body: EMPTY_COLLECTION });
});

describe('checking several companies in one call', () => {
  it('returns a result per company, in the order given', async () => {
    const result = await callToolOk(build(), 'tally_check_tie_out', {
      companies: ['Alpha Ltd', 'Beta Ltd'],
      ...PERIOD,
    });

    const named = (result.perCompany as PerCompany[]).map((entry) => entry.company);
    expect(named).toEqual(['Alpha Ltd', 'Beta Ltd']);
    expect(result.companiesChecked).toEqual(['Alpha Ltd', 'Beta Ltd']);
  });

  it('fails overall when ANY single company fails', async () => {
    // The property that makes this a gate rather than a summary. Beta is out;
    // a batch verdict of "passed" here would let a broken set of books through.
    let call = 0;
    mock.onBodyContaining('<ID>Ledgers</ID>', () => ({
      body: call++ === 0 ? EMPTY_COLLECTION : BROKEN_LEDGER,
    }));

    const result = await callToolOk(build(), 'tally_check_tie_out', {
      companies: ['Alpha Ltd', 'Beta Ltd'],
      ...PERIOD,
    });

    const per = result.perCompany as PerCompany[];
    expect(per[0]?.passed).toBe(true);
    expect(per[1]?.passed).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('refuses `company` and `companies` together', async () => {
    const error = await callToolError(build(), 'tally_check_tie_out', {
      company: 'Alpha Ltd',
      companies: ['Beta Ltd'],
      ...PERIOD,
    });

    expect(error.code).toBe('INVALID_PARAMETERS');
  });

  it('refuses the same company listed twice', async () => {
    // Checking one company twice would report its exceptions twice and double
    // the counts, which reads as a bigger problem than there is.
    const error = await callToolError(build(), 'tally_check_tie_out', {
      companies: ['Alpha Ltd', 'alpha ltd'],
      ...PERIOD,
    });

    expect(error.code).toBe('INVALID_PARAMETERS');
  });

  it('refuses a company that is not open in TallyPrime', async () => {
    const error = await callToolError(build(), 'tally_check_tie_out', {
      companies: ['Alpha Ltd', 'Not Open Ltd'],
      ...PERIOD,
    });

    expect(error.code).toBe('TALLY_COMPANY_NOT_LOADED');
  });
});

describe('findings carry an explicit severity', () => {
  it('reports a roll-forward failure as an exception, with its figures attached', async () => {
    mock.onBodyContaining('<ID>Ledgers</ID>', { body: BROKEN_LEDGER });

    const result = await callToolOk(build(), 'tally_check_tie_out', {
      company: 'Alpha Ltd',
      ...PERIOD,
    });

    const findings = result.findings as Finding[];
    const exception = findings.find((f) => f.code === 'balance_roll_forward_mismatch');

    expect(exception?.severity).toBe('exception');
    expect(exception?.subject).toBe('Suspense');
    // The figures must be present so the reader never re-derives them.
    expect(exception?.figures?.difference).toBeDefined();
    expect(result.highestSeverity).toBe('exception');
    expect((result.findingCounts as Record<string, number>).exception).toBe(1);
  });

  it('does not report an exception on books that tie', async () => {
    const result = await callToolOk(build(), 'tally_check_tie_out', {
      company: 'Alpha Ltd',
      ...PERIOD,
    });

    const findings = result.findings as Finding[];
    expect(findings.filter((f) => f.severity === 'exception')).toEqual([]);
    expect(result.passed).toBe(true);
  });
});

describe('verbosity: summary', () => {
  it('keeps every finding and reports how much explanation it dropped', async () => {
    mock.onBodyContaining('<ID>Ledgers</ID>', { body: BROKEN_LEDGER });

    const full = await callToolOk(build(), 'tally_check_tie_out', {
      company: 'Alpha Ltd',
      ...PERIOD,
    });
    const summary = await callToolOk(build(), 'tally_check_tie_out', {
      company: 'Alpha Ltd',
      verbosity: 'summary',
      ...PERIOD,
    });

    // THE property: nothing that reports a problem may be lost.
    expect(summary.findings).toEqual(full.findings);
    expect(summary.verbosity).toBe('summary');
    // And the omission must be visible rather than silent.
    expect(typeof summary.informationalNotesOmitted).toBe('number');
    expect(summary.warnings).toBeUndefined();
  });

  it('leaves the response unchanged at full verbosity, which is the default', async () => {
    const explicit = await callToolOk(build(), 'tally_check_tie_out', {
      company: 'Alpha Ltd',
      verbosity: 'full',
      ...PERIOD,
    });

    expect(explicit.verbosity).toBe('full');
    expect(explicit.informationalNotesOmitted).toBeUndefined();
  });
});
