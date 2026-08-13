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
import { registerVoucherTypeTools } from '../../src/tools/voucherTypes.js';
import { registerBankReconciliationTools } from '../../src/tools/bankReconciliation.js';
import { registerOutstandingTools } from '../../src/tools/outstanding.js';
import { registerReportTools } from '../../src/tools/reports.js';

/**
 * Tools and options added after v2: voucher type discovery, bank
 * reconciliation, statement comparison, and the opt-in ageing schedule.
 *
 * Each suite is written against the case that would produce a
 * plausible-but-wrong answer, not the happy path — a bill counted twice, a
 * reconciled cheque reported as uncleared, a null read as a zero, a receivable
 * misread as an over-settlement.
 */

let mock: MockTallyServer;
let port: number;

function build(overrides: Record<string, string> = {}): ToolRegistry {
  const registry = createToolRegistry();
  const deps = makeDeps(port, overrides);

  registerVoucherTypeTools(registry.server, deps);
  registerBankReconciliationTools(registry.server, deps);
  registerOutstandingTools(registry.server, deps);
  registerReportTools(registry.server, deps);

  return registry;
}

function serveDefaults(): void {
  mock.onBodyContaining('List of Companies', { body: fixture('company-list.xml') });
  mock.onBodyContaining('<ID>Ledgers</ID>', { body: fixture('ledger-list.xml') });
  mock.onBodyContaining('<ID>VoucherTypes</ID>', { body: fixture('voucher-types.xml') });
  mock.onBodyContaining('<TYPE>Voucher</TYPE>', { body: fixture('bank-vouchers.xml') });
  mock.onBodyContaining('Trial Balance', { body: fixture('trial-balance.xml') });
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

const PERIOD = { fromDate: '2026-07-01', toDate: '2026-07-31' };
const AGEING_PERIOD = { fromDate: '2026-04-01', toDate: '2026-07-31' };

interface TypeRow {
  name: string;
  parent: string | null;
  numberingSeries: {
    name: string | null;
    method: string | null;
    subMethod: string | null;
    preventsDuplicates: boolean;
  }[];
  isDeemedPositive: boolean;
}

describe('tally_get_voucher_types', () => {
  it('lists every type with the built-in it derives from', async () => {
    const result = await callToolOk(build(), 'tally_get_voucher_types');
    const rows = result.items as TypeRow[];

    expect(rows.map((r) => r.name)).toEqual([
      'Payment',
      'Sales',
      'Tax Invoice',
      'Purchase',
      'Journal',
    ]);
    expect(rows.find((r) => r.name === 'Tax Invoice')?.parent).toBe('Sales');
  });

  /**
   * The whole reason the tool exists. A caller searching "sales" needs to find
   * "Tax Invoice", because passing a guessed voucherType to tally_get_vouchers
   * returns zero rows and reads as an empty period.
   */
  it('matches on parent as well as name, so custom type names surface', async () => {
    const result = await callToolOk(build(), 'tally_get_voucher_types', { query: 'sales' });

    expect((result.items as TypeRow[]).map((r) => r.name)).toEqual(['Sales', 'Tax Invoice']);
  });

  /**
   * The regression for a bug that only live data exposed. TallyPrime's top-level
   * NUMBERINGMETHOD element is legacy and reads "None" on every voucher type,
   * while the real method lives in the nested VOUCHERNUMBERSERIES.LIST. The
   * first implementation read the scalar and confidently reported every type on
   * a real company as unnumbered, when all of them were Automatic/Auto Retain.
   *
   * The fixture carries the misleading "None" scalar on purpose: reading it
   * instead of the nested list must fail here.
   */
  it('reads the numbering method from the series, not the legacy scalar', async () => {
    const result = await callToolOk(build(), 'tally_get_voucher_types');
    const rows = result.items as TypeRow[];

    const sales = rows.find((r) => r.name === 'Sales');
    expect(sales?.numberingSeries).toEqual([
      { name: 'Default', method: 'Automatic', subMethod: 'Auto Retain', preventsDuplicates: false },
    ]);

    const taxInvoice = rows.find((r) => r.name === 'Tax Invoice');
    expect(taxInvoice?.numberingSeries[0]?.method).toBe('Manual');
    // No sub-method in the fixture, and absent means absent — not inherited.
    expect(taxInvoice?.numberingSeries[0]?.subMethod).toBeNull();

    // Nothing anywhere should surface the legacy "None".
    for (const row of rows) {
      expect(row).not.toHaveProperty('numberingMethod');
      for (const series of row.numberingSeries) expect(series.method).not.toBe('None');
    }
  });

  /** Directly audit-relevant: whether Tally itself would refuse a repeat. */
  it('reports whether a series prevents duplicate numbers', async () => {
    const result = await callToolOk(build(), 'tally_get_voucher_types');
    const rows = result.items as TypeRow[];

    expect(rows.find((r) => r.name === 'Payment')?.numberingSeries[0]?.preventsDuplicates).toBe(
      true
    );
    expect(rows.find((r) => r.name === 'Sales')?.numberingSeries[0]?.preventsDuplicates).toBe(
      false
    );
  });

  it('returns an empty series list where Tally reported none', async () => {
    const result = await callToolOk(build(), 'tally_get_voucher_types');
    const journal = (result.items as TypeRow[]).find((r) => r.name === 'Journal');

    // Empty means "Tally reported no series", never "unnumbered".
    expect(journal?.numberingSeries).toEqual([]);
  });

  it('filters on more than one field at once', async () => {
    const result = await callToolOk(build(), 'tally_get_voucher_types', {
      conditions: [
        { field: 'parent', op: 'eq', value: 'Sales' },
        { field: 'numberingMethod', op: 'eq', value: 'Manual' },
      ],
    });

    expect((result.items as TypeRow[]).map((r) => r.name)).toEqual(['Tax Invoice']);
  });

  /**
   * The nested numbering series cannot travel on a curated field list, so the
   * tool must ask for every field. If it stops doing so, numberingSeries goes
   * quietly empty and reads as "no series recorded".
   */
  it('asks TallyPrime for every field, since the series is nested', async () => {
    await callToolOk(build(), 'tally_get_voucher_types');
    const request = mock.requests.find((r) => r.body.includes('<ID>VoucherTypes</ID>'));

    expect(request?.body).toContain('<FETCH>*</FETCH>');
  });
});

interface BankRow {
  bankLedger: string;
  voucherNumber: string | null;
  bankDate: string | null;
  reconciled: boolean | null;
  instrument: Record<string, string>;
  entryAmount: { amount: string } | null;
}

describe('tally_get_bank_reconciliation', () => {
  it('returns one row per bank instrument and ignores vouchers without one', async () => {
    const result = await callToolOk(build(), 'tally_get_bank_reconciliation', PERIOD);
    const rows = result.items as BankRow[];

    // J-3 is a journal with no bank allocation and must not appear.
    expect(rows.map((r) => r.voucherNumber)).toEqual(['P-20', 'P-21', 'R-9']);
    // The bank ledger comes from the entry, not the voucher party.
    expect(new Set(rows.map((r) => r.bankLedger))).toEqual(new Set(['HDFC Bank Current A/c']));
  });

  /**
   * Tally marks an entry reconciled by stamping BANKERSDATE, and leaves it
   * empty otherwise. Reading that backwards would report a cleared cheque as
   * outstanding, or worse, an outstanding one as cleared.
   */
  it('reads reconciled status from the bank statement date', async () => {
    const result = await callToolOk(build(), 'tally_get_bank_reconciliation', PERIOD);
    const rows = result.items as BankRow[];

    const cleared = rows.find((r) => r.voucherNumber === 'P-20');
    expect(cleared?.reconciled).toBe(true);
    expect(cleared?.bankDate).toBe('2026-07-12');

    const uncleared = rows.find((r) => r.voucherNumber === 'P-21');
    expect(uncleared?.reconciled).toBe(false);
    expect(uncleared?.bankDate).toBeNull();

    expect(result.reconciliationStatusAvailable).toBe(true);
  });

  it('filters to unreconciled items, the month-end question', async () => {
    const result = await callToolOk(build(), 'tally_get_bank_reconciliation', {
      ...PERIOD,
      status: 'unreconciled',
    });

    expect((result.items as BankRow[]).map((r) => r.voucherNumber)).toEqual(['P-21', 'R-9']);
  });

  it('passes instrument fields through under Tally own names', async () => {
    const result = await callToolOk(build(), 'tally_get_bank_reconciliation', PERIOD);
    const rows = result.items as BankRow[];

    expect(rows.find((r) => r.voucherNumber === 'P-20')?.instrument.INSTRUMENTNUMBER).toBe('100234');
    expect(rows.find((r) => r.voucherNumber === 'R-9')?.instrument.TRANSACTIONID).toBe(
      'UTR9988776655'
    );
    expect(rows.find((r) => r.voucherNumber === 'R-9')?.instrument.TRANSACTIONTYPE).toBe(
      'e-Fund Transfer'
    );
  });

  /**
   * Measured on live data: eleven cash-denomination counters per instrument,
   * 2,200 of them across 200 cheques and wires, every one zero, 24% of the
   * response. Dropped only when zero — a real denomination count on a cash
   * transaction must never be filtered out.
   */
  it('drops zero denomination counters but keeps a non-zero one', async () => {
    const result = await callToolOk(build(), 'tally_get_bank_reconciliation', PERIOD);
    const rows = result.items as BankRow[];
    const receipt = rows.find((r) => r.voucherNumber === 'R-9');

    expect(receipt?.instrument.DENOMINATIONCOUNT500X).toBe('4');
    expect(receipt?.instrument).not.toHaveProperty('DENOMINATIONCOUNT2000X');
    expect(receipt?.instrument).not.toHaveProperty('DENOMINATIONCOUNT100X');
    // Everything else on the instrument is untouched.
    expect(receipt?.instrument.TRANSACTIONID).toBe('UTR9988776655');
  });

  it('finds an instrument by reference without being told the field name', async () => {
    const result = await callToolOk(build(), 'tally_get_bank_reconciliation', {
      ...PERIOD,
      instrumentMatch: 'UTR99887',
    });

    expect((result.items as BankRow[]).map((r) => r.voucherNumber)).toEqual(['R-9']);
  });

  it('keeps Tally signs, so a receipt and a payment differ in direction', async () => {
    const result = await callToolOk(build(), 'tally_get_bank_reconciliation', PERIOD);
    const rows = result.items as BankRow[];

    expect(rows.find((r) => r.voucherNumber === 'P-20')?.entryAmount?.amount).toBe('60000');
    expect(rows.find((r) => r.voucherNumber === 'R-9')?.entryAmount?.amount).toBe('-40000');
  });

  /**
   * The dangerous case. When no entry in the period carries a bank date, the
   * absence of one proves nothing — the company may simply not use the feature.
   * Reporting every instrument as "unreconciled" would state that as fact.
   */
  describe('when the company records no bank dates at all', () => {
    beforeEach(() => {
      mock.reset();
      serveDefaults();
      // day-book.xml has one bank allocation with BANKERSDATE empty.
      mock.onBodyContaining('<TYPE>Voucher</TYPE>', { body: fixture('day-book.xml') });
    });

    it('reports status as unknown rather than unreconciled', async () => {
      const result = await callToolOk(build(), 'tally_get_bank_reconciliation', PERIOD);
      const rows = result.items as BankRow[];

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.reconciled).toBeNull();
      expect(result.reconciliationStatusAvailable).toBe(false);
      expect((result.warnings as string[]).some((w) => /UNKNOWN/.test(w))).toBe(true);
    });

    it('refuses a status filter instead of answering it wrongly', async () => {
      const error = await callToolError(build(), 'tally_get_bank_reconciliation', {
        ...PERIOD,
        status: 'unreconciled',
      });

      expect(error.code).toBe('TALLY_UNSUPPORTED_OPERATION');
      expect(error.suggestion).toMatch(/status "all"/);
    });
  });
});

interface FigureChange {
  current: { amount: string } | null;
  previous: { amount: string } | null;
  change: { amount: string } | null;
  basis?: string;
}

interface RowChange {
  name: string;
  figures: Record<string, FigureChange>;
}

/**
 * The mock company's books begin 2021-04-01, so the financial year TallyPrime
 * would accumulate to ends 2022-03-31. A period ending there is the only shape
 * where the end date is known to bind — see END_DATE_NOTE in reports.ts.
 */
const FY_END = '2022-03-31';
const CUMULATIVE = { fromDate: '2021-04-01', toDate: FY_END };

describe('tally_get_statement period comparison', () => {
  it('returns a single period unchanged when no comparison is asked for', async () => {
    const result = await callToolOk(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      ...PERIOD,
    });

    expect(result).not.toHaveProperty('comparison');
  });

  /**
   * The most consequential finding of the live run. TallyPrime ignores SVTODATE
   * on these reports and accumulates to the financial year end, so a mid-year
   * statement is NOT the period requested. Answering it silently would let a
   * cumulative figure be quoted as a quarter's.
   */
  it('flags a mid-year period as not covering what was asked for', async () => {
    const result = await callToolOk(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      ...PERIOD,
    });

    expect(result.coversPeriodRequested).toBe(false);
    expect(result.figuresActuallyCover).toEqual({ fromDate: PERIOD.fromDate, toDate: FY_END });
    expect((result.warnings as string[]).some((w) => /ignores the end date/i.test(w))).toBe(true);
  });

  it('reports a period ending at the financial year end as covered', async () => {
    const result = await callToolOk(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      ...CUMULATIVE,
    });

    expect(result.coversPeriodRequested).toBe(true);
    expect(result).not.toHaveProperty('figuresActuallyCover');
  });

  /**
   * Refusing rather than answering. If both sides accumulate to the same year
   * end, the subtraction collapses to minus the whole of the earlier period — on
   * live data that would have reported sales down 211,852.50 when sales were
   * flat. A wrong figure of plausible size is the worst possible output here.
   */
  it('refuses a comparison whose period does not end at the year end', async () => {
    const error = await callToolError(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      ...PERIOD,
      compareFromDate: '2026-06-01',
      compareToDate: '2026-06-30',
    });

    expect(error.code).toBe('TALLY_UNSUPPORTED_OPERATION');
    expect(error.message).toMatch(/accumulate to the same year end/);
    expect(error.suggestion).toContain(FY_END);
  });

  it('fetches both periods and subtracts figure by figure', async () => {
    const result = await callToolOk(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      ...CUMULATIVE,
      compareFromDate: '2021-04-01',
      compareToDate: FY_END,
    });

    const comparison = result.comparison as { period: unknown; changes: RowChange[] };
    expect(comparison.period).toEqual({ fromDate: '2021-04-01', toDate: FY_END });

    // The mock serves the same trial balance for both periods, so every paired
    // figure must net to exactly zero. Any non-zero here means the arithmetic
    // or the pairing is wrong.
    for (const row of comparison.changes) {
      for (const change of Object.values(row.figures)) {
        if (change.change !== null) expect(change.change.amount).toBe('0');
      }
    }
    expect(comparison.changes.length).toBeGreaterThan(0);
  });

  /**
   * Tally reports an empty column as null, which means "nothing here" and not
   * zero — the two appear side by side in real statements. Subtracting against
   * a null would invent a movement of the full amount of the other period.
   */
  it('computes no change where either figure is null, and says why', async () => {
    const result = await callToolOk(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      ...CUMULATIVE,
      compareFromDate: '2021-04-01',
      compareToDate: FY_END,
    });

    const changes = (result.comparison as { changes: RowChange[] }).changes;
    const withNull = changes.flatMap((row) =>
      Object.values(row.figures).filter((f) => f.current === null || f.previous === null)
    );

    expect(withNull.length).toBeGreaterThan(0);
    for (const figure of withNull) {
      expect(figure.change).toBeNull();
      expect(figure.basis).toMatch(/not treated as zero|not the same as zero/i);
    }
  });

  it('refuses one half of a comparison range', async () => {
    const error = await callToolError(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      ...CUMULATIVE,
      compareFromDate: '2021-04-01',
    });

    expect(error.code).toBe('INVALID_DATE_RANGE');
    expect(error.message).toMatch(/both compareFromDate and compareToDate/);
  });
});

interface AgeingAside {
  count: number;
  amount: { amount: string };
}

interface PartyAgeing {
  buckets: { label: string; count: number; amount: { amount: string } }[];
  undated: AgeingAside;
  unreferenced: AgeingAside;
  settlementsAgainstEarlierBills: AgeingAside;
  overSettled: AgeingAside;
  settledInPeriod: number;
}

interface PartyRow {
  party: string;
  ageing?: PartyAgeing;
}

describe('tally_get_outstanding ageing', () => {
  beforeEach(() => {
    mock.reset();
    serveDefaults();
    mock.onBodyContaining('<TYPE>Voucher</TYPE>', { body: fixture('bills-ageing.xml') });
  });

  function ageingFor(rows: PartyRow[], party: string): PartyAgeing | undefined {
    return rows.find((r) => r.party.startsWith(party))?.ageing;
  }

  /** The previous contract: nothing about ageing appears unless asked for. */
  it('stays off by default', async () => {
    const result = await callToolOk(build(), 'tally_get_outstanding', {
      side: 'payable',
      ...AGEING_PERIOD,
      includeZeroBalances: true,
    });

    expect(result).not.toHaveProperty('ageingBasis');
    for (const row of result.items as PartyRow[]) expect(row).not.toHaveProperty('ageing');
  });

  it('buckets open bills by how long ago they were raised', async () => {
    const result = await callToolOk(build(), 'tally_get_outstanding', {
      side: 'payable',
      ...AGEING_PERIOD,
      includeZeroBalances: true,
      includeAgeing: true,
    });

    const ageing = ageingFor(result.items as PartyRow[], 'Bramley');
    const byLabel = new Map(ageing?.buckets.map((b) => [b.label, b]));

    // B-3, raised 10-Jul, 21 days old as at 31-Jul.
    expect(byLabel.get('0-30 days')).toMatchObject({ count: 1, amount: { amount: '30000' } });
    // B-1, raised 01-Apr, 121 days old.
    expect(byLabel.get('90+ days')).toMatchObject({ count: 1, amount: { amount: '100000' } });
    expect(byLabel.get('31-60 days')?.count).toBe(0);
    expect(byLabel.get('61-90 days')?.count).toBe(0);
  });

  /**
   * Tally records an invoice as New Ref and each payment as Agst Ref against
   * the same reference. Bucketing the allocations as they arrive would show B-2
   * at its full 50000 and again as a payment.
   */
  it('nets settlements against the bill they were applied to', async () => {
    const result = await callToolOk(build(), 'tally_get_outstanding', {
      side: 'payable',
      ...AGEING_PERIOD,
      includeZeroBalances: true,
      includeAgeing: true,
    });

    const ageing = ageingFor(result.items as PartyRow[], 'Bramley');
    // B-2 raised and settled inside the period.
    expect(ageing?.settledInPeriod).toBe(1);
    // ...and therefore in no bucket: 30000 + 100000, not 180000.
    const bucketed = (ageing?.buckets ?? []).reduce(
      (total, bucket) => total + Number(bucket.amount.amount),
      0
    );
    expect(bucketed).toBe(130000);
  });

  /**
   * The coverage limitation, made visible. A payment against a reference that
   * was never raised in this period proves the invoice is older than the range
   * and absent from the data. Ageing it from the payment date would age the
   * payment.
   */
  it('separates settlements against bills raised before the period', async () => {
    const result = await callToolOk(build(), 'tally_get_outstanding', {
      side: 'payable',
      ...AGEING_PERIOD,
      includeZeroBalances: true,
      includeAgeing: true,
    });

    const ageing = ageingFor(result.items as PartyRow[], 'Bramley');
    expect(ageing?.settlementsAgainstEarlierBills).toEqual({
      count: 1,
      amount: { amount: '-15000', currency: 'INR' },
    });
  });

  it('holds "On Account" allocations apart from any bill', async () => {
    const result = await callToolOk(build(), 'tally_get_outstanding', {
      side: 'payable',
      ...AGEING_PERIOD,
      includeZeroBalances: true,
      includeAgeing: true,
    });

    const ageing = ageingFor(result.items as PartyRow[], 'Bramley');
    expect(ageing?.unreferenced).toEqual({
      count: 1,
      amount: { amount: '-5000', currency: 'INR' },
    });
  });

  it('reports a bill paid beyond its value as over-settled, not as outstanding', async () => {
    const result = await callToolOk(build(), 'tally_get_outstanding', {
      side: 'payable',
      ...AGEING_PERIOD,
      includeZeroBalances: true,
      includeAgeing: true,
    });

    const ageing = ageingFor(result.items as PartyRow[], 'Bramley');
    // B-4: raised 10000, paid 12000.
    expect(ageing?.overSettled).toEqual({ count: 1, amount: { amount: '-2000', currency: 'INR' } });
  });

  /**
   * The regression that matters most. TallyPrime encodes debits negative, so an
   * open receivable bill and an over-settled payable have the SAME sign.
   * Judging outstanding-ness by sign alone reports every open receivable as an
   * over-settlement.
   */
  it('ages a negative receivable bill as outstanding, not as over-settled', async () => {
    const result = await callToolOk(build(), 'tally_get_outstanding', {
      side: 'receivable',
      ...AGEING_PERIOD,
      includeZeroBalances: true,
      includeAgeing: true,
    });

    const ageing = ageingFor(result.items as PartyRow[], 'Northwind Retail Limited');
    const byLabel = new Map(ageing?.buckets.map((b) => [b.label, b]));

    // S-9, raised 05-Jul, 26 days old, and still negative in Tally's encoding.
    expect(byLabel.get('0-30 days')).toMatchObject({ count: 1, amount: { amount: '-20000' } });
    expect(ageing?.overSettled.count).toBe(0);
  });

  it('states the basis and the coverage bound on every ageing response', async () => {
    const result = await callToolOk(build(), 'tally_get_outstanding', {
      side: 'payable',
      ...AGEING_PERIOD,
      includeZeroBalances: true,
      includeAgeing: true,
    });

    expect(result.ageingBasis).toEqual({
      asOn: '2026-07-31',
      measure: 'days since the bill was raised, not days overdue',
      buckets: [30, 60, 90],
      coverage: 'bills raised between 2026-04-01 and 2026-07-31 only',
    });
    expect((result.warnings as string[]).some((w) => /NOT days overdue/.test(w))).toBe(true);
  });

  it('honours caller-supplied buckets and an explicit as-on date', async () => {
    const result = await callToolOk(build(), 'tally_get_outstanding', {
      side: 'payable',
      ...AGEING_PERIOD,
      includeZeroBalances: true,
      includeAgeing: true,
      ageingAsOn: '2026-07-15',
      ageingBuckets: [7, 14],
    });

    const ageing = ageingFor(result.items as PartyRow[], 'Bramley');
    expect(ageing?.buckets.map((b) => b.label)).toEqual([
      'future-dated',
      '0-7 days',
      '8-14 days',
      '14+ days',
    ]);
    // B-3 raised 10-Jul is 5 days old as at 15-Jul.
    expect(ageing?.buckets.find((b) => b.label === '0-7 days')?.count).toBe(1);
  });

  /** Overlapping buckets would count a bill twice and look entirely normal. */
  it('rejects bucket boundaries that do not ascend', async () => {
    const error = await callToolError(build(), 'tally_get_outstanding', {
      side: 'payable',
      ...AGEING_PERIOD,
      includeAgeing: true,
      ageingBuckets: [60, 30],
    });

    expect(error.code).toBe('INVALID_PARAMETERS');
    expect(error.message).toMatch(/ascend strictly/);
  });
});

/**
 * The trial balance and the ledger list can report different figures for the
 * same group, and on stock they do.
 *
 * Found live 2026-08-13, and invisible to every test that existed: the tools
 * were each faithfully reporting a number TallyPrime gave them. `trial_balance`
 * put Current Assets at -385,764.46 while the closing balances from
 * `tally_get_ledgers` summed to -482,384.46 — a 96,620.00 gap, exactly the
 * year's movement on `Stock In Hand`. `balance_sheet` agreed with the masters
 * to the cent, on every group.
 *
 * Neither figure is adjusted; §6 rule 1 forbids that. What is asserted here is
 * that the disagreement is DISCLOSED, because a 20% difference quoted from
 * whichever tool ran first is a wrong answer of plausible size.
 */
describe('tally_get_statement discloses divergence from the ledger masters', () => {
  function serveDivergence(): void {
    mock.reset();
    mock.onBodyContaining('List of Companies', { body: fixture('company-list.xml') });
    mock.onBodyContaining('<ID>Groups</ID>', { body: fixture('groups.xml') });
    mock.onBodyContaining('<ID>Ledgers</ID>', {
      body: fixture('stock-divergence-ledgers.xml'),
    });
    mock.onBodyContaining('Trial Balance', {
      body: fixture('stock-divergence-trial-balance.xml'),
    });
  }

  it('warns when a group total disagrees with the ledgers filed under it', async () => {
    serveDivergence();
    const result = await callToolOk(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      ...CUMULATIVE,
    });

    const warning = (result.warnings as string[]).find((w) => w.includes('Current Assets'));
    expect(warning).toBeDefined();
    // Both figures, and the gap, stated rather than implied.
    expect(warning).toContain('-125000');
    expect(warning).toContain('-200000');
    expect(warning).toContain('75000');
  });

  /**
   * The gap is attributed by arithmetic, not by looking for an account called
   * "stock": a row carried at its opening value differs from the masters by
   * exactly opening minus closing. That identifies the account without this
   * code having to know in advance which one it should be.
   */
  it('names the account whose movement accounts for the gap', async () => {
    serveDivergence();
    const result = await callToolOk(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      ...CUMULATIVE,
    });

    const warning = (result.warnings as string[]).find((w) => w.includes('Current Assets'));
    expect(warning).toContain('Stock In Hand');
    expect(warning).toMatch(/OPENING value/);
    expect(warning).toMatch(/CLOSING value/);
  });

  /** A group that agrees must stay silent, or the warning trains readers to ignore it. */
  it('says nothing about groups that agree', async () => {
    serveDivergence();
    const result = await callToolOk(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      ...CUMULATIVE,
    });

    const warnings = (result.warnings ?? []) as string[];
    expect(warnings.some((w) => w.includes('Capital Account'))).toBe(false);
    // "Profit & Loss A/c" has no ledgers filed under it — Tally derives it — so
    // it has nothing to be compared against and must not be reported as a break.
    expect(warnings.some((w) => w.includes('Profit & Loss'))).toBe(false);
  });

  /**
   * A diagnostic must never turn a correct answer into an error. With no group
   * collection served, the roll-up cannot be done at all — and the statement
   * must still come back, silently.
   */
  it('still answers when the masters cannot be read', async () => {
    mock.reset();
    mock.onBodyContaining('List of Companies', { body: fixture('company-list.xml') });
    mock.onBodyContaining('Trial Balance', {
      body: fixture('stock-divergence-trial-balance.xml'),
    });

    const result = await callToolOk(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      ...CUMULATIVE,
    });

    expect((result.rows as unknown[]).length).toBe(3);
    const warnings = (result.warnings ?? []) as string[];
    expect(warnings.some((w) => w.includes('Current Assets'))).toBe(false);
  });
});
