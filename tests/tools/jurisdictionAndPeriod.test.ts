import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolOk,
  createToolRegistry,
  makeDeps,
  type ToolRegistry,
} from './harness.js';
import { registerTdsTools } from '../../src/tools/tds.js';
import { registerReportTools } from '../../src/tools/reports.js';
import { registerGenericReportTools } from '../../src/tools/genericReport.js';
import { checkStockTieOut } from '../../src/tools/tieOut.js';
import { Decimal } from 'decimal.js';

/**
 * Three warnings that asserted things which were not true, found by running the
 * connector against four real company books on 2026-08-18.
 *
 * All three share one shape: the figures were right and the SENTENCE ATTACHED
 * TO THEM was wrong. That is the failure mode this codebase treats as the
 * serious one, because a wrong figure invites a second look and a confident
 * wrong explanation does not.
 *
 * 1. `tally_get_tds` emitted "For an Indian company ... that is itself the
 *    audit point" as a CONSTANT — byte-identical on a German GmbH, a US LLC
 *    and an Indian private limited. TDS is an Indian withholding tax, so on the
 *    first two the sentence asserts an audit implication that does not exist.
 * 2. The same warning claimed the TDS feature was "unused" on a company whose
 *    chart of accounts contains TDS Payable, TDS on Salary 192B and TDS ON
 *    PROFESSIONAL FEES carrying balances. Deduction was being operated outside
 *    Tally's TDS machinery — a worse control finding, reported as a clean one.
 * 3. `profit_loss` and `tally_get_report` answered over a defaulted year of
 *    which only fourteen days held data, and said nothing. Every ratio struck
 *    on it read as annual.
 */

let mock: MockTallyServer;
let port: number;

const INDIA = 'MUDALS TECHNOLOGIES PRIVATE LIMITED';
const GERMANY = 'AGBV Nutrition GmbH';
const USA = 'AgEx Pharma LLC';

/**
 * `endingAt` differs per company on purpose. USA stops on 2026-04-14 — fourteen
 * days into the book year its own start date implies — which is the live shape
 * that produced the partial-period bug.
 */
const COMPANY_LIST = `<ENVELOPE><BODY><DATA><COLLECTION>
  <COMPANY NAME="${INDIA}" RESERVEDNAME="">
    <STARTINGFROM TYPE="Date">20210401</STARTINGFROM>
    <ENDINGAT TYPE="Date">20270331</ENDINGAT>
    <NAME TYPE="String">${INDIA}</NAME>
    <CURRENCYNAME TYPE="String">INR</CURRENCYNAME>
    <COUNTRYNAME TYPE="String">India</COUNTRYNAME>
  </COMPANY>
  <COMPANY NAME="${GERMANY}" RESERVEDNAME="">
    <STARTINGFROM TYPE="Date">20230101</STARTINGFROM>
    <ENDINGAT TYPE="Date">20261231</ENDINGAT>
    <NAME TYPE="String">${GERMANY}</NAME>
    <CURRENCYNAME TYPE="String">EUR</CURRENCYNAME>
    <COUNTRYNAME TYPE="String">Germany</COUNTRYNAME>
  </COMPANY>
  <COMPANY NAME="${USA}" RESERVEDNAME="">
    <STARTINGFROM TYPE="Date">20240401</STARTINGFROM>
    <ENDINGAT TYPE="Date">20260414</ENDINGAT>
    <NAME TYPE="String">${USA}</NAME>
    <CURRENCYNAME TYPE="String">$</CURRENCYNAME>
    <COUNTRYNAME TYPE="String">United States of America</COUNTRYNAME>
  </COMPANY>
</COLLECTION></DATA></BODY></ENVELOPE>`;

/**
 * Ledgers with every TDS flag explicitly negative — which is how Tally really
 * reports a company that does not use the feature, and the reason the original
 * warning was written. `names` become ledger names verbatim so a chart of
 * accounts containing "TDS Payable" can be distinguished from one that does not.
 */
function ledgerList(names: readonly string[]): string {
  const ledgers = names
    .map(
      (name) =>
        `<LEDGER NAME="${name}">` +
        `<NAME TYPE="String">${name}</NAME>` +
        `<PARENT TYPE="String">Current Liabilities</PARENT>` +
        `<ISTDSAPPLICABLE TYPE="Logical">No</ISTDSAPPLICABLE>` +
        `<ISTCSAPPLICABLE TYPE="Logical">No</ISTCSAPPLICABLE>` +
        `<ISTDSEXPENSE TYPE="Logical">No</ISTDSEXPENSE>` +
        `<IGNORETDSEXEMPT TYPE="Logical">No</IGNORETDSEXEMPT>` +
        `<TDSDEDUCTEEISSPECIALRATE TYPE="Logical">No</TDSDEDUCTEEISSPECIALRATE>` +
        `</LEDGER>`
    )
    .join('');
  return `<ENVELOPE><BODY><DATA><COLLECTION>${ledgers}</COLLECTION></DATA></BODY></ENVELOPE>`;
}

const CLEAN_LEDGERS = ledgerList(['Rent', 'Professional Fees', 'Bank Charges']);
const LEDGERS_WITH_TDS_ACCOUNTS = ledgerList([
  'Rent',
  'TDS Payable',
  'TDS on Salary 192B',
  'TDS ON PROFESSIONAL FEES',
]);

/**
 * One P&L row in TallyPrime's own paired-tag layout.
 *
 * Name and value are SIBLINGS, not nested: `pairReportRows` walks the direct
 * children of the report container and pairs each `DSPACCNAME` with the
 * `PLAMT` that follows it.
 */
function plRow(name: string, sub: string | null, main: string | null): string {
  return (
    `<DSPACCNAME><DSPDISPNAME>${name}</DSPDISPNAME></DSPACCNAME>` +
    `<PLAMT><PLSUBAMT>${sub ?? ''}</PLSUBAMT><BSMAINAMT>${main ?? ''}</BSMAINAMT></PLAMT>`
  );
}

/**
 * The live AgEx Pharma LLC shape: opening and closing stock at the SAME figure,
 * no purchases, and therefore no cost of sales at all.
 */
const PROFIT_LOSS_STALE_STOCK =
  '<ENVELOPE>' +
  plRow('Sales Accounts', null, '50033.50') +
  plRow('Cost of Sales :', null, null) +
  plRow('Opening Stock', '-304588', null) +
  plRow('Less: Closing Stock', '-304588', null) +
  '</ENVELOPE>';

/** The same statement with a closing stock that moved, as a control. */
const PROFIT_LOSS_MOVED_STOCK =
  '<ENVELOPE>' +
  plRow('Sales Accounts', null, '50033.50') +
  plRow('Cost of Sales :', null, '-64900.06') +
  plRow('Opening Stock', '-304588', null) +
  plRow('Less: Closing Stock', '-239687.94', null) +
  '</ENVELOPE>';

/** One Stock Summary row, in the same sibling-pair layout as the statements. */
function stockRow(name: string, qty: string, rate: string, value: string): string {
  return (
    `<DSPACCNAME><DSPDISPNAME>${name}</DSPDISPNAME></DSPACCNAME>` +
    `<DSPSTKINFO><DSPSTKCL>` +
    `<DSPCLQTY>${qty}</DSPCLQTY><DSPCLRATE>${rate}</DSPCLRATE><DSPCLAMTA>${value}</DSPCLAMTA>` +
    `</DSPSTKCL></DSPSTKINFO>`
  );
}

/**
 * TallyPrime's Stock Summary totalling -239,687.94 across three items — the
 * live AgEx figures, against a P&L still carrying -304,588.
 */
const STOCK_SUMMARY =
  '<ENVELOPE>' +
  stockRow('Acetyle-L-Carnitine HCL', '1000.00 Kgs.', '20.00', '-20000.00') +
  stockRow('L-Carnitine Base', '9425.00 Kgs.', '19.04', '-179461.52') +
  stockRow('L-Carnitine L-Tartrate', '2600.00 Kgs.', '15.47', '-40226.42') +
  '</ENVELOPE>';

function tdsRegistry(): ToolRegistry {
  const registry = createToolRegistry();
  registerTdsTools(registry.server, makeDeps(port));
  return registry;
}

function reportRegistry(): ToolRegistry {
  const registry = createToolRegistry();
  registerGenericReportTools(registry.server, makeDeps(port));
  return registry;
}

/**
 * Every warning on a response, flattened, so assertions read as prose.
 *
 * `callToolOk` has already unwrapped the §4 envelope's `data`, so warnings sit
 * at the top level here rather than under `data`.
 */
function warningsOf(payload: Record<string, unknown>): string {
  const warnings = payload.warnings;
  return Array.isArray(warnings) ? warnings.join('\n') : '';
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
  mock.onBodyContaining('List of Companies', { body: COMPANY_LIST });
  mock.onBodyContaining('<ID>Currencies</ID>', {
    body: '<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>',
  });
});

describe('tally_get_tds gates its audit implication on the company country', () => {
  it('does not claim an audit point on a German company', async () => {
    mock.onBodyContaining('<ID>Ledgers</ID>', { body: CLEAN_LEDGERS });

    const result = await callToolOk(tdsRegistry(), 'tally_get_tds', {
      view: 'summary',
      company: GERMANY,
    });
    const warnings = warningsOf(result);

    // The exact sentence that shipped on a GmbH.
    expect(warnings).not.toContain('that is itself the audit point');
    expect(warnings).toContain('Germany');
    expect(warnings).toContain('NO audit implication');
  });

  it('does not claim an audit point on a US company', async () => {
    mock.onBodyContaining('<ID>Ledgers</ID>', { body: CLEAN_LEDGERS });

    const result = await callToolOk(tdsRegistry(), 'tally_get_tds', {
      view: 'summary',
      company: USA,
    });

    expect(warningsOf(result)).not.toContain('that is itself the audit point');
    expect(warningsOf(result)).toContain('United States of America');
  });

  it('keeps the audit point for an Indian company with a clean chart', async () => {
    mock.onBodyContaining('<ID>Ledgers</ID>', { body: CLEAN_LEDGERS });

    const result = await callToolOk(tdsRegistry(), 'tally_get_tds', {
      view: 'summary',
      company: INDIA,
    });

    // The original finding is correct here and must survive the fix.
    expect(warningsOf(result)).toContain('that is itself the audit point');
  });

  it('emits different text per country from one call to the next', async () => {
    mock.onBodyContaining('<ID>Ledgers</ID>', { body: CLEAN_LEDGERS });

    const india = warningsOf(
      await callToolOk(tdsRegistry(), 'tally_get_tds', { view: 'summary', company: INDIA })
    );
    const germany = warningsOf(
      await callToolOk(tdsRegistry(), 'tally_get_tds', { view: 'summary', company: GERMANY })
    );

    // The defect was that these were byte-identical.
    expect(india).not.toEqual(germany);
  });
});

describe('tally_get_tds does not report unused when TDS ledgers exist', () => {
  it('reports deduction operated outside the TDS machinery', async () => {
    mock.onBodyContaining('<ID>Ledgers</ID>', { body: LEDGERS_WITH_TDS_ACCOUNTS });

    const result = await callToolOk(tdsRegistry(), 'tally_get_tds', {
      view: 'summary',
      company: INDIA,
    });
    const warnings = warningsOf(result);

    expect(warnings).toContain('outside TallyPrime');
    expect(warnings).toContain('TDS Payable');
    // The false reassurance that shipped.
    expect(warnings).not.toContain('the feature is unused');
  });

  it('does not fire on a chart with no TDS-named ledgers', async () => {
    mock.onBodyContaining('<ID>Ledgers</ID>', { body: CLEAN_LEDGERS });

    const result = await callToolOk(tdsRegistry(), 'tally_get_tds', {
      view: 'summary',
      company: INDIA,
    });

    expect(warningsOf(result)).not.toContain('outside TallyPrime');
  });

  it('does not treat ordinary names containing DEDUCT or SECTION as TDS accounts', async () => {
    // TDS_FIELD_HINTS includes DEDUCT and SECTION, which are safe against
    // Tally's concatenated field names and would be false positives here.
    mock.onBodyContaining('<ID>Ledgers</ID>', {
      body: ledgerList(['Deductions from Salary', 'C Section Rent']),
    });

    const result = await callToolOk(tdsRegistry(), 'tally_get_tds', {
      view: 'summary',
      company: INDIA,
    });

    expect(warningsOf(result)).not.toContain('outside TallyPrime');
    expect(warningsOf(result)).toContain('that is itself the audit point');
  });
});

describe('a period running past the end of the books is disclosed', () => {
  it('warns that only part of the window holds data', async () => {
    mock.onBodyContaining('<ID>Ratio Analysis</ID>', {
      body:
        '<ENVELOPE><BODY><DATA><TALLYMESSAGE>' +
        '<RATIONAME>Current Ratio</RATIONAME><RATIOVALUE>1.08 : 1</RATIOVALUE>' +
        '</TALLYMESSAGE></DATA></BODY></ENVELOPE>',
    });

    // No dates: the defaulted book year runs to 2027-03-31 while the books
    // stop on 2026-04-14 — the live AgEx Pharma LLC shape.
    const result = await callToolOk(reportRegistry(), 'tally_get_report', {
      report: 'ratio_analysis',
      company: USA,
    });
    const warnings = warningsOf(result);

    expect(warnings).toContain('PARTIAL PERIOD');
    expect(warnings).toContain('2026-04-14');
    expect(warnings).toContain('14 of 365 days');
  });

  it('stays silent when the books cover the whole period', async () => {
    mock.onBodyContaining('<ID>Ratio Analysis</ID>', {
      body:
        '<ENVELOPE><BODY><DATA><TALLYMESSAGE>' +
        '<RATIONAME>Current Ratio</RATIONAME><RATIOVALUE>1.68 : 1</RATIOVALUE>' +
        '</TALLYMESSAGE></DATA></BODY></ENVELOPE>',
    });

    // Germany's books run to 2026-12-31, exactly its own calendar book year.
    const result = await callToolOk(reportRegistry(), 'tally_get_report', {
      report: 'ratio_analysis',
      company: GERMANY,
    });

    expect(warningsOf(result)).not.toContain('PARTIAL PERIOD');
  });

  it('stays silent for a company whose books reach the period end', async () => {
    mock.onBodyContaining('<ID>Ratio Analysis</ID>', {
      body:
        '<ENVELOPE><BODY><DATA><TALLYMESSAGE>' +
        '<RATIONAME>Current Ratio</RATIONAME><RATIOVALUE>0.49 : 1</RATIOVALUE>' +
        '</TALLYMESSAGE></DATA></BODY></ENVELOPE>',
    });

    const result = await callToolOk(reportRegistry(), 'tally_get_report', {
      report: 'ratio_analysis',
      company: INDIA,
    });

    expect(warningsOf(result)).not.toContain('PARTIAL PERIOD');
  });
});

describe('profit_loss discloses a closing stock the Stock Summary disagrees with', () => {
  function statementRegistry(): ToolRegistry {
    const registry = createToolRegistry();
    registerReportTools(registry.server, makeDeps(port));
    return registry;
  }

  it('warns when opening and closing stock are the same figure', async () => {
    mock.onBodyContaining('<ID>Profit and Loss</ID>', { body: PROFIT_LOSS_STALE_STOCK });
    mock.onBodyContaining('<ID>Stock Summary</ID>', { body: STOCK_SUMMARY });

    const result = await callToolOk(statementRegistry(), 'tally_get_statement', {
      statement: 'profit_loss',
      company: USA,
      fromDate: '2026-04-01',
      toDate: '2027-03-31',
    });
    const warnings = warningsOf(result);

    expect(warnings).toContain('SAME figure');
    expect(warnings).toContain('304588.00');
    // The point an accountant needs: gross profit is affected, and the
    // entries and the valuation fail separately.
    expect(warnings).toContain('gross profit is overstated');
    expect(warnings).toContain('tally_get_inventory_movements');
  });

  it('reports the gap against the Stock Summary and its direction', async () => {
    mock.onBodyContaining('<ID>Profit and Loss</ID>', { body: PROFIT_LOSS_STALE_STOCK });
    mock.onBodyContaining('<ID>Stock Summary</ID>', { body: STOCK_SUMMARY });

    const result = await callToolOk(statementRegistry(), 'tally_get_statement', {
      statement: 'profit_loss',
      company: USA,
      fromDate: '2026-04-01',
      toDate: '2027-03-31',
    });
    const warnings = warningsOf(result);

    // 304,588.00 - 239,687.94, the live figure this was found on.
    expect(warnings).toContain('64900.06');
    expect(warnings).toContain('OVERSTATED');
  });

  it('stays silent when the P&L agrees with the Stock Summary', async () => {
    mock.onBodyContaining('<ID>Profit and Loss</ID>', { body: PROFIT_LOSS_MOVED_STOCK });
    mock.onBodyContaining('<ID>Stock Summary</ID>', { body: STOCK_SUMMARY });

    const result = await callToolOk(statementRegistry(), 'tally_get_statement', {
      statement: 'profit_loss',
      company: USA,
      fromDate: '2026-04-01',
      toDate: '2027-03-31',
    });
    const warnings = warningsOf(result);

    expect(warnings).not.toContain('SAME figure');
    expect(warnings).not.toContain('does NOT agree');
  });
});

/**
 * The inventory tie-out, and why it reports two figures rather than one.
 *
 * Found live 2026-08-18 on AgEx Pharma LLC. A closing-only comparison gives
 * 64,900.06 and reads as "closing stock is stale". Checking both ends splits it
 * into two unrelated faults with different owners:
 *
 *   stock records   273,909.89 opening -> 239,687.94 closing  (34,221.95 used)
 *   general ledger  304,588.00 opening -> 304,588.00 closing  (no movement)
 *
 * 30,678.11 was already wrong before the period began; 34,221.95 is stock
 * consumed that never reached the general ledger. Their sum is the number a
 * single check would have reported, and it names neither cause.
 */
describe('checkStockTieOut', () => {
  const money = (amount: string) => ({ amount, currency: '$' });

  /** A stock-in-hand account in the model's own debit-positive convention. */
  function stockAccount(name: string, opening: string, closing: string) {
    return {
      name,
      isPostable: true,
      path: ['Current Assets', 'Stock-in-Hand', name],
      openingBalance: { magnitude: money(opening), side: 'debit' as const },
      closingBalance: { magnitude: money(closing), side: 'debit' as const },
    };
  }

  /** Stock items as TallyPrime reports them — debit encoded NEGATIVE. */
  function stockItem(name: string, opening: string, closing: string) {
    return { name, openingValue: money(opening), closingValue: money(closing) };
  }

  const AGEX_ITEMS = [
    stockItem('Acetyle-L-Carnitine HCL', '-22000', '-20000'),
    stockItem('L-Carnitine Base', '-196598.53', '-179461.52'),
    stockItem('L-Carnitine L-Tartrate', '-55311.36', '-40226.42'),
  ];

  it('separates the opening error from the unposted movement', () => {
    const result = checkStockTieOut(
      [stockAccount('Stock In Hand', '304588', '304588')] as never,
      AGEX_ITEMS,
      '$'
    );

    expect(result.checked).toBe(2);
    expect(result.exceptions).toHaveLength(2);

    const opening = result.exceptions.find((e) => e.at === 'opening');
    const closing = result.exceptions.find((e) => e.at === 'closing');

    // Already wrong before the period began.
    expect(opening?.difference.magnitude.amount).toBe('30678.11');
    // Opening error plus the 34,221.95 consumed but never posted.
    expect(closing?.difference.magnitude.amount).toBe('64900.06');
    expect(opening?.perStockRecords.magnitude.amount).toBe('273909.89');
    expect(closing?.perStockRecords.magnitude.amount).toBe('239687.94');
  });

  it('reconciles the two ends to the movement in the stock records', () => {
    const result = checkStockTieOut(
      [stockAccount('Stock In Hand', '304588', '304588')] as never,
      AGEX_ITEMS,
      '$'
    );
    const opening = result.exceptions.find((e) => e.at === 'opening');
    const closing = result.exceptions.find((e) => e.at === 'closing');

    const consumed = new Decimal(closing?.difference.magnitude.amount ?? '0').minus(
      new Decimal(opening?.difference.magnitude.amount ?? '0')
    );
    // 273,909.89 - 239,687.94, the stock actually used in the period.
    expect(consumed.toFixed(2)).toBe('34221.95');
  });

  it('compares magnitudes across the two sign conventions', () => {
    // The GL side is debit-positive; the stock side is Tally's debit-negative.
    // Compared raw these differ by twice the balance on books that agree.
    const result = checkStockTieOut(
      [stockAccount('Stock In Hand', '239687.94', '239687.94')] as never,
      [stockItem('Only Item', '-239687.94', '-239687.94')],
      '$'
    );

    expect(result.checked).toBe(2);
    expect(result.exceptions).toHaveLength(0);
  });

  it('is not applicable, rather than passing, when there is no inventory', () => {
    const none = checkStockTieOut([], [], '$');
    expect(none.checked).toBe(0);
    expect(none.exceptions).toHaveLength(0);
    expect(none.notApplicableReason).toContain('keeps no inventory');
  });

  it('distinguishes stock records with no ledger from having no inventory', () => {
    // AGBV Nutrition GmbH, live: 13 stock items with real movement and NO
    // stock ledger anywhere in the general ledger. Reporting this the same way
    // as "no inventory" would call an untied balance a clean result.
    const result = checkStockTieOut([], AGEX_ITEMS, '$');

    expect(result.checked).toBe(0);
    expect(result.exceptions).toHaveLength(0);
    expect(result.notApplicableReason).toContain('NO stock ledger');
    expect(result.notApplicableReason).toContain('UNTIED');
    // Must NOT read as the benign case.
    expect(result.notApplicableReason).not.toContain('keeps no inventory');
  });

  it('flags a stock ledger with no stock records behind it', () => {
    const result = checkStockTieOut(
      [stockAccount('Stock In Hand', '1000', '1000')] as never,
      [],
      '$'
    );

    expect(result.checked).toBe(0);
    expect(result.notApplicableReason).toContain('no stock record');
  });

  it('refuses to total a set with a missing value rather than treating it as zero', () => {
    const result = checkStockTieOut(
      [stockAccount('Stock In Hand', '304588', '304588')] as never,
      [
        stockItem('Readable', '-100', '-100'),
        { name: 'Unreadable', openingValue: null, closingValue: null },
      ],
      '$'
    );

    expect(result.exceptions).toHaveLength(0);
    expect(result.checked).toBe(0);
    expect(result.notCheckable.join('\n')).toContain('is not a zero');
  });

  it('ignores a rounding-level difference', () => {
    const result = checkStockTieOut(
      [stockAccount('Stock In Hand', '1000.00', '1000.00')] as never,
      [stockItem('Only Item', '-1000.005', '-1000.005')],
      '$'
    );

    expect(result.exceptions).toHaveLength(0);
  });
});
