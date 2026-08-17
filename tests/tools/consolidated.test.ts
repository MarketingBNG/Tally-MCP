import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolError,
  callToolOk,
  createToolRegistry,
  fixture,
  makeDeps,
  type ToolRegistry,
} from './harness.js';
import { registerMasterTools } from '../../src/tools/masters.js';
import { registerVoucherTestTools } from '../../src/tools/testVouchers.js';
import { registerGenericReportTools } from '../../src/tools/genericReport.js';

/**
 * The Phase 1b consolidation, and the two tools it made room for.
 *
 * Two things are under test here, and the second matters more than the first.
 *
 * 1. That `tally_get_masters` answers all four master questions correctly.
 * 2. That the merge did not FLATTEN THE CAVEATS. Four tool descriptions became
 *    one, and the failure mode of that move is a single generic paragraph that
 *    has quietly swallowed the sentences the old descriptions used to carry —
 *    the ledger balance-sign rule, the voucher-type duplicate-numbering
 *    guidance. Nothing about that failure shows up in a passing test suite
 *    unless the text itself is asserted, which is what the last describe block
 *    below does.
 */

let mock: MockTallyServer;
let port: number;

function build(overrides: Record<string, string> = {}): ToolRegistry {
  const registry = createToolRegistry();
  const deps = makeDeps(port, overrides);
  registerMasterTools(registry.server, deps);
  registerVoucherTestTools(registry.server, deps);
  registerGenericReportTools(registry.server, deps);
  return registry;
}

const GROUP_LIST_XML =
  '<ENVELOPE><BODY><DATA>' +
  '<GROUP>0</GROUP>' +
  '<GROUP NAME="Sundry Debtors"><PARENT>Current Assets</PARENT>' +
  '<ISREVENUE>No</ISREVENUE><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></GROUP>' +
  '<GROUP NAME="Direct Expenses"><PARENT>Expenses</PARENT>' +
  '<ISREVENUE>Yes</ISREVENUE><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></GROUP>' +
  '</DATA></BODY></ENVELOPE>';

/** A report in the shape every TallyPrime report view has used so far. */
const NEGATIVE_LEDGERS_XML =
  '<ENVELOPE>' +
  '<DSPACCNAME><DSPDISPNAME>Petty Cash</DSPDISPNAME></DSPACCNAME>' +
  '<DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA>-4200.00</DSPCLDRAMTA></DSPCLDRAMT></DSPACCINFO>' +
  '<DSPACCNAME><DSPDISPNAME>Cash in Hand</DSPDISPNAME></DSPACCNAME>' +
  '<DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA>-150.50</DSPCLDRAMTA></DSPCLDRAMT></DSPACCINFO>' +
  '</ENVELOPE>';

/** TallyPrime's reply to a valid report with nothing to show. */
const EMPTY_REPORT_XML = '<ENVELOPE></ENVELOPE>';

function serveDefaults(): void {
  mock.onBodyContaining('List of Companies', { body: fixture('company-list.xml') });
  mock.onBodyContaining('<ID>Ledgers</ID>', { body: fixture('ledger-list.xml') });
  mock.onBodyContaining('<ID>Groups</ID>', { body: GROUP_LIST_XML });
  mock.onBodyContaining('<ID>VoucherTypes</ID>', { body: fixture('voucher-types.xml') });
  mock.onBodyContaining('<ID>StockItems</ID>', { body: fixture('stock-items-populated.xml') });
  mock.onBodyContaining('<TYPE>Voucher</TYPE>', { body: fixture('day-book.xml') });
  mock.onBodyContaining('<ID>Negative Ledgers</ID>', { body: NEGATIVE_LEDGERS_XML });
  mock.onBodyContaining('<ID>Negative Stock</ID>', { body: EMPTY_REPORT_XML });
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
  serveDefaults();
});

describe('tally_get_masters answers all four master questions', () => {
  it('lists ledgers', async () => {
    const result = await callToolOk(build(), 'tally_get_masters', { type: 'ledger' });
    expect((result.items as unknown[]).length).toBeGreaterThan(0);
  });

  it('lists groups, with the P&L / balance sheet classification', async () => {
    const result = await callToolOk(build(), 'tally_get_masters', { type: 'group' });
    const items = result.items as { name: string; isRevenue: boolean }[];
    expect(items.find((g) => g.name === 'Direct Expenses')?.isRevenue).toBe(true);
    expect(items.find((g) => g.name === 'Sundry Debtors')?.isRevenue).toBe(false);
  });

  it('lists voucher types with their numbering series', async () => {
    const result = await callToolOk(build(), 'tally_get_masters', { type: 'voucherType' });
    expect((result.items as unknown[]).length).toBeGreaterThan(0);
  });

  it('lists stock items', async () => {
    const result = await callToolOk(build(), 'tally_get_masters', { type: 'stockItem' });
    expect((result.items as unknown[]).length).toBeGreaterThan(0);
  });

  it('keeps each type searching the fields it searched before the merge', async () => {
    // Groups search NAME ONLY, on purpose: matching parent too would make
    // "Expenses" return every group filed under it, which is the opposite of
    // searching the hierarchy by name. Ledgers and stock items DO search
    // parent, and voucher types search parent precisely because that is where
    // the built-in type they derive from is named.
    const groups = await callToolOk(build(), 'tally_get_masters', {
      type: 'group',
      query: 'Expenses',
    });
    expect((groups.items as { name: string }[]).map((g) => g.name)).toEqual(['Direct Expenses']);
  });

  it('fetches one ledger by exact name', async () => {
    const result = await callToolOk(build(), 'tally_get_masters', {
      type: 'ledger',
      name: 'Northwind Retail',
    });
    expect(result.ledger).toBeDefined();
  });

  it('fails naming what was asked for, rather than returning null', async () => {
    // A typo has to be distinguishable from a ledger that genuinely holds
    // nothing, which a null result would not be.
    const error = await callToolError(build(), 'tally_get_masters', {
      type: 'ledger',
      name: 'No Such Ledger',
    });
    expect(error.code).toBe('TALLY_COMPANY_NOT_FOUND');
    expect(error.message).toContain('No Such Ledger');
  });

  it('names the right noun in the error for each type', async () => {
    const error = await callToolError(build(), 'tally_get_masters', {
      type: 'stockItem',
      name: 'No Such Item',
    });
    expect(error.message).toContain('stock item');
  });

  it('refuses `name` on a type that has no exact-name mode, instead of ignoring it', async () => {
    // Silently ignoring it would answer a different question — the whole list
    // instead of one record — and look like success.
    const error = await callToolError(build(), 'tally_get_masters', {
      type: 'group',
      name: 'Sundry Debtors',
    });
    expect(error.code).toBe('INVALID_PARAMETERS');
    expect(error.suggestion).toContain('query');
  });

  /**
   * `name` used to win silently over `query` and `conditions`.
   *
   * The handler returned early on `name`, so the other two were never applied —
   * while the tool description told Claude that all three combined and each
   * narrowed the result. A call carrying a contradictory pair therefore came
   * back with the named record, looking exactly like a filtered answer that had
   * been honoured. Nothing in the response said half the request was dropped,
   * which is why this is asserted rather than left to the description.
   */
  it('refuses `name` together with `query`, instead of silently dropping the query', async () => {
    const error = await callToolError(build(), 'tally_get_masters', {
      type: 'ledger',
      name: 'Accounting Charges',
      query: 'nothing-like-cash',
    });
    expect(error.code).toBe('INVALID_PARAMETERS');
    expect(error.message).toContain('not both');
  });

  it('refuses `name` together with `conditions` for the same reason', async () => {
    const error = await callToolError(build(), 'tally_get_masters', {
      type: 'ledger',
      name: 'Accounting Charges',
      conditions: [{ field: 'gstin', op: 'isNotNull' }],
    });
    expect(error.code).toBe('INVALID_PARAMETERS');
    expect(error.message).toContain('not both');
  });

  it('still accepts `name` alone, and an empty conditions array alongside it', async () => {
    // An empty array is not a condition. Rejecting it would break a caller that
    // builds the argument list programmatically and passes [] for "no filters".
    const result = await callToolOk(build(), 'tally_get_masters', {
      type: 'ledger',
      name: 'Accounting Charges',
      conditions: [],
    });
    expect(result.ledger).toBeDefined();
  });

  it('applies conditions per type with that type own fields', async () => {
    const result = await callToolOk(build(), 'tally_get_masters', {
      type: 'group',
      conditions: [{ field: 'isRevenue', op: 'eq', value: true }],
    });
    expect((result.items as { name: string }[]).map((g) => g.name)).toEqual(['Direct Expenses']);
  });

  it('rejects a field that belongs to a different type', async () => {
    // `gstin` is a ledger field. Accepting it on groups would silently return
    // everything, since nothing would match.
    const error = await callToolError(build(), 'tally_get_masters', {
      type: 'group',
      conditions: [{ field: 'gstin', op: 'eq', value: 'X' }],
    });
    expect(error.code).toBe('INVALID_PARAMETERS');
  });
});

describe('the merged description keeps every type-specific caveat', () => {
  // Part 0 rule 4: a merge that flattens the caveats into one generic
  // paragraph has broken the accuracy contract, and nothing else in this suite
  // would catch it. These are the sentences that were load-bearing in the four
  // descriptions that went away.
  const description = (): string => build().descriptions.get('tally_get_masters') ?? '';

  it('keeps the ledger balance-sign rule', () => {
    expect(description()).toContain('negative closing balance denotes a debit balance');
    expect(description()).toContain('NOT the same as a balance of zero');
  });

  it('keeps the voucher-type duplicate-numbering guidance', () => {
    expect(description()).toContain('preventsDuplicates');
    expect(description()).toContain('rather than calling a repeat an error on its own');
  });

  it('keeps the warning that an empty numbering series is not "None"', () => {
    expect(description()).toContain('Do not read absence as "None"');
  });

  it('keeps the point that groups carry no balance', () => {
    expect(description()).toContain('NO BALANCE');
  });

  it('keeps the point that no stock items is a real answer', () => {
    expect(description()).toContain('does not keep stock');
  });

  it('keeps the warning that company-specific type names break name matching', () => {
    expect(description()).toContain('Tax Invoice');
  });

  it('still says pagination does not make the call cheap', () => {
    expect(description()).toContain('does NOT make the call cheap');
  });
});

describe('tally_get_report', () => {
  it('returns rows under TallyPrime own tag names, not renamed columns', async () => {
    // Renaming DSPCLDRAMTA to "debit" on a report whose columns have not been
    // verified would produce a figure that is right in value and wrong in
    // meaning — the hardest kind of error to notice later.
    const result = await callToolOk(build(), 'tally_get_report', { report: 'negative_ledgers' });
    const rows = result.items as { name: string; amounts: Record<string, string> }[];
    expect(rows.map((r) => r.name)).toEqual(['Petty Cash', 'Cash in Hand']);
    expect(rows[0]?.amounts.DSPCLDRAMTA).toBe('-4200.00');
    expect(rows[0]?.amounts).not.toHaveProperty('debit');
  });

  it('says the amount keys are tag names, every time', async () => {
    const result = await callToolOk(build(), 'tally_get_report', { report: 'negative_ledgers' });
    expect((result.warnings as string[]).join(' ')).toContain("TallyPrime's own tag names");
  });

  it('flags a report whose row shape has never been observed', async () => {
    // TallyPrime accepts "Negative Stock", but it returned nothing on the
    // company this server was tested against, so its layout is unproven.
    const result = await callToolOk(build(), 'tally_get_report', { report: 'negative_stock' });
    expect((result.warnings as string[]).join(' ')).toContain('ROW SHAPE UNVERIFIED');
  });

  it('treats an empty report as a real answer, not a failure', async () => {
    const result = await callToolOk(build(), 'tally_get_report', { report: 'negative_stock' });
    expect(result.items).toEqual([]);
    // ...but does not let it read as a clean bill of health either.
    expect((result.warnings as string[]).join(' ')).toContain('check whether this company uses');
  });

  it('echoes the report ID it actually sent', async () => {
    const result = await callToolOk(build(), 'tally_get_report', { report: 'negative_ledgers' });
    expect(result.reportId).toBe('Negative Ledgers');
  });

  it('refuses an ID that is not on the allowlist', () => {
    const registry = build();
    const schema = registry.schemas.get('tally_get_report');
    expect(() => schema?.parse({ report: 'Some Unverified Report' })).toThrow();
  });
});

describe('tally_test_vouchers', () => {
  it('reports the population it tested and what it left out', async () => {
    // The counts are not decoration: a Benford test over a population
    // containing orders measures something other than the company's
    // transactions, and still returns a confident-looking conformity band.
    const result = await callToolOk(build(), 'tally_test_vouchers', {
      test: 'round_numbers',
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });
    expect(result.population).toHaveProperty('tested');
    expect(result.population).toHaveProperty('excluded');
  });

  it('carries the candidates-not-findings note on the result itself', async () => {
    // On the RESULT, not only in the tool description: a description is read
    // once when choosing the tool, and this has to survive being quoted out of
    // context into a workpaper.
    const result = await callToolOk(build(), 'tally_test_vouchers', {
      test: 'weekend',
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });
    expect(String(result.candidateNote)).toContain('CANDIDATES FOR REVIEW, not findings');
  });

  it('states the Saturday/Sunday assumption rather than leaving it implied', async () => {
    const result = await callToolOk(build(), 'tally_test_vouchers', {
      test: 'weekend',
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });
    expect(result.weekendDays).toEqual(['Saturday', 'Sunday']);
    expect((result.warnings as string[]).join(' ')).toContain('SATURDAY AND SUNDAY WERE ASSUMED');
  });

  it('says the weekend test is not an out-of-hours posting test', async () => {
    const result = await callToolOk(build(), 'tally_test_vouchers', {
      test: 'weekend',
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });
    expect((result.warnings as string[]).join(' ')).toContain('Edit Log');
  });

  it('returns the seed with a sample, so the sample can be drawn again', async () => {
    const result = await callToolOk(build(), 'tally_test_vouchers', {
      test: 'sample',
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
      sampleSize: 2,
      sampleSeed: 'workpaper-7',
    });
    expect((result.sample as { seed: string }).seed).toBe('workpaper-7');
  });

  it('warns that the same seed over a different population gives a different sample', async () => {
    const result = await callToolOk(build(), 'tally_test_vouchers', {
      test: 'sample',
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
      sampleSize: 2,
    });
    expect((result.warnings as string[]).join(' ')).toContain('record the period and filters');
  });

  it('discloses that journals were matched on type name, not a Tally flag', async () => {
    // TallyPrime has no "is a manual journal" flag, so an empty result is a
    // statement about the type names and not about whether the company posts
    // manual journals. Saying that is the difference between a screen and a
    // false negative presented as assurance.
    const result = await callToolOk(build(), 'tally_test_vouchers', {
      test: 'journal_screen',
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });
    expect((result.warnings as string[]).join(' ')).toContain(
      'JOURNALS WERE IDENTIFIED BY TYPE NAME'
    );
  });

  it('says when it did not test journals on size', async () => {
    const result = await callToolOk(build(), 'tally_test_vouchers', {
      test: 'journal_screen',
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });
    expect((result.warnings as string[]).join(' ')).toContain('NOT tested on size');
  });

  it('refuses to let a Benford result read as a conclusion', async () => {
    const result = await callToolOk(build(), 'tally_test_vouchers', {
      test: 'benford',
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });
    expect((result.warnings as string[]).join(' ')).toContain('NOT A CONCLUSION');
  });

  it('says a repeated amount is not a duplicate posting', async () => {
    const result = await callToolOk(build(), 'tally_test_vouchers', {
      test: 'duplicates',
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });
    expect((result.warnings as string[]).join(' ')).toContain('NOT A DUPLICATE POSTING');
  });

  it('says cut-off proximity is not evidence', async () => {
    const result = await callToolOk(build(), 'tally_test_vouchers', {
      test: 'cutoff',
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });
    expect((result.warnings as string[]).join(' ')).toContain('PROXIMITY, NOT EVIDENCE');
  });

  it('rejects a test name that does not exist', () => {
    const registry = build();
    const schema = registry.schemas.get('tally_test_vouchers');
    expect(() => schema?.parse({ test: 'vibes' })).toThrow();
  });
});

describe('related-party screening', () => {
  it('seeds from TallyPrime own flag and reports which names it used', async () => {
    // Corrects earlier research for this project, which concluded Tally holds
    // no related-party marking. It does — `IsRelatedParty` — and it is the
    // right seed even though it is not by itself a complete list.
    const result = await callToolOk(build(), 'tally_test_vouchers', {
      test: 'related_party',
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });
    expect(result).toHaveProperty('relatedPartiesFlaggedInTally');
    expect(result).toHaveProperty('relatedPartiesSupplied');
  });

  it('says plainly that an unmarked ledger is not an unrelated ledger', async () => {
    const result = await callToolOk(build(), 'tally_test_vouchers', {
      test: 'related_party',
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });
    expect((result.warnings as string[]).join(' ')).toContain(
      'A LEDGER NOT MARKED IS NOT A LEDGER THAT IS NOT RELATED'
    );
  });

  it('refuses to let an empty-by-construction result read as assurance', async () => {
    // No flag set and no list supplied means the answer is empty for a reason
    // that has nothing to do with the company. Saying so is the whole point.
    const result = await callToolOk(build(), 'tally_test_vouchers', {
      test: 'related_party',
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });
    expect((result.warnings as string[]).join(' ')).toContain('empty by construction');
  });

  it('flags vouchers against a party on the supplied list', async () => {
    const result = await callToolOk(build(), 'tally_test_vouchers', {
      test: 'related_party',
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
      relatedParties: ['Northwind Retail Limited'],
    });
    const candidates = result.candidates as { party: string; reasons: string[] }[];
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.reasons.join(' ')).toContain('list you supplied');
    // ...and with a list supplied, the empty-by-construction caveat is no
    // longer true, so it must not be attached.
    expect((result.warnings as string[]).join(' ')).not.toContain('empty by construction');
  });
});
