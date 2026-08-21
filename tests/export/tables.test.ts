import { describe, it, expect } from 'vitest';
import type { Decimal } from 'decimal.js';
import {
  balanceSheetTable,
  nestedStructureTables,
  usedMastersTable,
  ledgerBalancesTable,
  ledgersTable,
  notInThisWorkbookTable,
  receivablesTable,
  sheetName,
  tallyDefaultsTable,
  trialBalanceTable,
  voucherEntriesTable,
  vouchersTable,
  voucherTypesTable,
} from '../../src/export/tables.js';
import { contentsTable, manifestTable, roundTripFailures } from '../../src/export/manifest.js';
import { companyData, ledger, money, voucher } from './fixtures.js';

/**
 * What a column MEANS.
 *
 * These are the tests worth having here. The workbook is the interface now —
 * nobody is going to read a warning attached to a tool call — so a debit column
 * that is not a debit, or a folded field that was actually dropped, would reach
 * an accountant as a wrong figure with nothing flagging it.
 */

describe('the books', () => {
  it('splits an entry into debit and credit from Tally\'s own flag, not the sign', () => {
    const data = companyData({
      vouchers: [
        voucher({
          entries: [
            // A debit whose amount is POSITIVE. The flag and the sign disagree
            // here on purpose: only the flag may decide the column.
            { ledgerName: 'Bank', amount: money('900.00'), side: 'debit' },
            { ledgerName: 'Sales', amount: money('-900.00'), side: 'credit' },
          ],
        }),
      ],
    });

    const table = voucherEntriesTable(data);
    const debitCol = table.columns.findIndex((c) => c.header === 'Debit');
    const creditCol = table.columns.findIndex((c) => c.header === 'Credit');

    expect(table.rows).toHaveLength(2);
    expect((table.rows[0]?.[debitCol] as Decimal).toString()).toBe('900');
    expect(table.rows[0]?.[creditCol]).toBeNull();
    expect(table.rows[1]?.[debitCol]).toBeNull();
    expect((table.rows[1]?.[creditCol] as Decimal).toString()).toBe('-900');
  });

  it('writes a date as a real Date, not a string', () => {
    const table = vouchersTable(companyData());
    const dateCol = table.columns.findIndex((c) => c.header === 'Date');
    expect(table.rows[0]?.[dateCol]).toBeInstanceOf(Date);
    expect(table.columns[dateCol]?.kind).toBe('date');
  });

  it('keeps the write timestamp as text, since Tally records no timezone', () => {
    const table = voucherEntriesTable(companyData());
    const column = table.columns.find((c) => c.header === 'Last written');
    expect(column?.kind).toBe('stamp');
  });

  it('carries the four exclusion flags on the Vouchers tab', () => {
    const headers = vouchersTable(companyData()).columns.map((c) => c.header);
    expect(headers).toEqual(
      expect.arrayContaining(['Cancelled', 'Optional', 'Order voucher', 'Inventory voucher'])
    );
  });

  it('reports a null balance as empty, never as zero', () => {
    const data = companyData({ ledgers: [ledger({ closingBalance: null })] });
    const table = ledgerBalancesTable(data);
    const column = table.columns.findIndex((c) => c.header === 'Closing balance');
    expect(table.rows[0]?.[column]).toBeNull();
  });

  it('preserves the trial balance sign rather than correcting it', () => {
    const table = trialBalanceTable(companyData());
    const debit = table.columns.findIndex((c) => c.header === 'Debit');
    expect((table.rows[0]?.[debit] as Decimal).toString()).toBe('-1500');
  });
});

describe('row order', () => {
  /** Three vouchers deliberately handed over in the wrong order. */
  const scrambled = () =>
    companyData({
      vouchers: [
        voucher({ guid: 'c', date: '2026-07-20', voucherNumber: 'INV-3' }),
        voucher({ guid: 'a', date: '2026-07-01', voucherNumber: 'INV-1' }),
        voucher({ guid: 'b', date: '2026-07-10', voucherNumber: 'INV-2' }),
      ],
    });

  it('puts vouchers in date order whatever order Tally returned them', () => {
    const table = vouchersTable(scrambled());
    const dates = table.rows.map((row) => (row[0] as Date).toISOString().slice(0, 10));
    expect(dates).toEqual(['2026-07-01', '2026-07-10', '2026-07-20']);
  });

  it('uses the SAME order on Voucher entries, so the two tabs agree', () => {
    const data = scrambled();
    const guidColumn = vouchersTable(data).columns.findIndex((c) => c.header === 'GUID');
    const fromVouchers = vouchersTable(data).rows.map((row) => row[guidColumn]);

    const entries = voucherEntriesTable(data);
    const entryGuid = entries.columns.findIndex((c) => c.header === 'Voucher GUID');
    // Each voucher contributes two entries, so dedupe to compare sequences.
    const fromEntries = [...new Set(entries.rows.map((row) => row[entryGuid]))];

    expect(fromEntries).toEqual(fromVouchers);
  });

  it('uses the same order on the detail tabs too', () => {
    const data = companyData({
      vouchers: [
        voucher({
          guid: 'later',
          date: '2026-07-20',
          nested: { 'GSTDETAILS.LIST': [{ fields: { RATE: '18' } }] },
        }),
        voucher({
          guid: 'earlier',
          date: '2026-07-01',
          nested: { 'GSTDETAILS.LIST': [{ fields: { RATE: '5' } }] },
        }),
      ],
    });

    const table = nestedStructureTables(data).find((t) => t.title === 'GST breakdown');
    const guid = table?.columns.findIndex((c) => c.header === 'Voucher GUID') ?? -1;
    expect(table?.rows.map((row) => row[guid])).toEqual(['earlier', 'later']);
  });

  it('keeps entries WITHIN a voucher in the order Tally posted them', () => {
    // Re-sorting these would separate a debit from the credit it pairs with.
    const table = voucherEntriesTable(companyData({ vouchers: [voucher()] }));
    const ledgerColumn = table.columns.findIndex((c) => c.header === 'Ledger');
    expect(table.rows.map((row) => row[ledgerColumn])).toEqual(['ACME Ltd', 'Sales']);
  });

  it('files ledgers case-insensitively, so CASHBACK sits beside Cash Withdrawal', () => {
    // Tally's own order is case-SENSITIVE, which puts every capitalised name in
    // a block of its own — measured live, CASHBACK sorted 40 rows above Cash
    // Withdrawal, which is how somebody concludes a ledger is missing.
    const data = companyData({
      ledgers: [
        ledger({ name: 'Cash Withdrawal' }),
        ledger({ name: 'CASHBACK' }),
        ledger({ name: 'Capital' }),
      ],
    });
    // Dictionary order, so "Cash Withdrawal" precedes "Cashback" — a space
    // sorts before a letter. The point is not which of the two comes first; it
    // is that CASE no longer decides, so they land next to each other.
    expect(ledgerBalancesTable(data).rows.map((row) => row[0])).toEqual([
      'Capital',
      'Cash Withdrawal',
      'CASHBACK',
    ]);
  });

  it('does not let case alone separate two names', () => {
    const data = companyData({
      ledgers: [ledger({ name: 'zebra' }), ledger({ name: 'Apple' }), ledger({ name: 'BANANA' })],
    });
    // Tally's own case-sensitive order would give Apple, BANANA, zebra only by
    // luck; on real data it produced every capitalised name in a block of its
    // own. Case-insensitively there is one sequence, which is what a reader
    // scanning for a ledger expects.
    expect(ledgerBalancesTable(data).rows.map((row) => row[0])).toEqual([
      'Apple',
      'BANANA',
      'zebra',
    ]);
  });

  it('leaves the STATEMENTS in Tally\'s own order, because that order is the document', () => {
    // A balance sheet reads Capital Account, then Loans, then Current
    // Liabilities. Sorting it alphabetically would scatter every group away
    // from its own subtotal and destroy the meaning of the page.
    const data = companyData({
      balanceSheet: {
        ...companyData().balanceSheet,
        rows: [
          { name: 'Capital Account', amount: money('100.00'), subAmount: null },
          { name: 'Loans (Liability)', amount: money('200.00'), subAmount: null },
          { name: 'Current Liabilities', amount: money('300.00'), subAmount: null },
        ],
      },
    });

    expect(balanceSheetTable(data).rows.map((row) => row[0])).toEqual([
      'Capital Account',
      'Loans (Liability)',
      'Current Liabilities',
    ]);
  });

  it('is deterministic: the same books produce the same order twice', () => {
    const first = vouchersTable(scrambled()).rows.map((row) => row[11]);
    const second = vouchersTable(scrambled()).rows.map((row) => row[11]);
    expect(first).toEqual(second);
  });
});

describe('the fold is a relocation, not a filter', () => {
  it('puts a field that never varies on Tally defaults, and off the record tab', () => {
    const data = companyData();
    const vouchers = vouchersTable(data);
    const defaults = tallyDefaultsTable(data);

    // ISDELETED is "No" on both vouchers, so it folds.
    expect(vouchers.columns.map((c) => c.header)).not.toContain('ISDELETED');
    expect(defaults.rows.some((row) => row[0] === 'Vouchers' && row[1] === 'ISDELETED')).toBe(true);
  });

  it('keeps a field that varies as a column', () => {
    const headers = vouchersTable(companyData()).columns.map((c) => c.header);
    expect(headers).toContain('REFERENCE');
  });

  it('LOSES NOTHING: every source field is a column or a default', () => {
    const data = companyData();

    const check = (
      records: readonly { fields?: Record<string, string> }[],
      what: string,
      columns: string[]
    ): void => {
      const defaults = tallyDefaultsTable(data)
        .rows.filter((row) => row[0] === what)
        .map((row) => String(row[1]));

      const present = new Set([...columns, ...defaults]);
      for (const record of records) {
        for (const key of Object.keys(record.fields ?? {})) {
          expect(present, `${what} field ${key} vanished`).toContain(key);
        }
      }
    };

    check(data.vouchers, 'Vouchers', vouchersTable(data).columns.map((c) => c.header));
    check(data.ledgers, 'Ledgers', ledgersTable(data).columns.map((c) => c.header));
  });

  it('folds nothing below two records, since one record makes every field uniform', () => {
    const data = companyData({ vouchers: [voucher()] });
    expect(vouchersTable(data).columns.map((c) => c.header)).toContain('ISDELETED');
    expect(tallyDefaultsTable(data).rows.some((row) => row[0] === 'Vouchers')).toBe(false);
  });
});

describe('data and fields nobody wrote code for', () => {
  /**
   * Nothing about the shape of a company's data is hardcoded, and these are the
   * tests that keep it that way.
   *
   * Which fields exist is a property of the COMPANY, not of TallyPrime: one with
   * GST configured carries GST fields, a payroll company carries payroll fields,
   * and a company that switches a feature on tomorrow starts carrying fields
   * that did not exist in any export before it. A workbook built from a fixed
   * column list would silently drop every one of them.
   */

  it('gives a field nobody has ever seen a column of its own', () => {
    const data = companyData({
      vouchers: [
        voucher({ guid: 'a', fields: { ISDELETED: 'No', SOMETHINGBRANDNEW: 'first sighting' } }),
        voucher({ guid: 'b', fields: { ISDELETED: 'No', SOMETHINGBRANDNEW: 'second value' } }),
      ],
    });

    const table = vouchersTable(data);
    const column = table.columns.findIndex((c) => c.header === 'SOMETHINGBRANDNEW');
    expect(column).toBeGreaterThan(-1);
    expect(table.rows[0]?.[column]).toBe('first sighting');
  });

  it('moves a field OUT of Tally defaults the moment it starts varying', () => {
    // The company switches something on. Yesterday every voucher said "No" and
    // the field sat on the defaults tab; today one says "Yes". It has to become
    // a column, or the change is invisible.
    const before = companyData({
      vouchers: [
        voucher({ guid: 'a', fields: { AUDITED: 'No' } }),
        voucher({ guid: 'b', fields: { AUDITED: 'No' } }),
      ],
    });
    expect(vouchersTable(before).columns.map((c) => c.header)).not.toContain('AUDITED');
    expect(tallyDefaultsTable(before).rows.some((row) => row[1] === 'AUDITED')).toBe(true);

    const after = companyData({
      vouchers: [
        voucher({ guid: 'a', fields: { AUDITED: 'No' } }),
        voucher({ guid: 'b', fields: { AUDITED: 'Yes' } }),
      ],
    });
    expect(vouchersTable(after).columns.map((c) => c.header)).toContain('AUDITED');
    expect(tallyDefaultsTable(after).rows.some((row) => row[1] === 'AUDITED')).toBe(false);
  });

  it('keeps a field that only SOME records carry, rather than folding it away', () => {
    // Present on one voucher and absent on the other. That absence is
    // information — Tally left it empty there — so it must not be asserted
    // globally on the defaults tab.
    const data = companyData({
      vouchers: [
        voucher({ guid: 'a', fields: { NEWFIELD: 'set here' } }),
        voucher({ guid: 'b', fields: {} }),
      ],
    });

    const table = vouchersTable(data);
    const column = table.columns.findIndex((c) => c.header === 'NEWFIELD');
    expect(column).toBeGreaterThan(-1);
    expect(table.rows[0]?.[column]).toBe('set here');
    // Empty, not zero and not a guess.
    expect(table.rows[1]?.[column]).toBeNull();
  });

  it('picks up a nested structure the company has never used before', () => {
    // A company that starts using bill-wise accounting: the tab was empty in
    // every previous export and fills itself, columns and all.
    const data = companyData({
      vouchers: [
        voucher({
          entries: [
            {
              ledgerName: 'ACME Ltd',
              amount: money('-1000.00'),
              side: 'debit',
              nested: {
                'BILLALLOCATIONS.LIST': [
                  { fields: { NAME: 'INV-1', SOMENEWALLOCATIONFIELD: 'appeared today' } },
                ],
              },
            },
          ],
        }),
      ],
    });

    const table = nestedStructureTables(data).find((t) => t.title === 'Bill allocations');
    expect(table?.columns.map((c) => c.header)).toContain('SOMENEWALLOCATIONFIELD');
    expect(table?.rows[0]).toContain('appeared today');
  });

  it('carries a brand-new ledger and a brand-new voucher type without being told', () => {
    const data = companyData({
      ledgers: [ledger({ name: 'A Ledger Created This Morning' })],
      voucherTypes: [
        { name: 'A Type Nobody Defined Before', parent: 'Sales', numberingSeries: [], isDeemedPositive: false },
      ],
    });

    expect(ledgerBalancesTable(data).rows.map((row) => row[0])).toContain(
      'A Ledger Created This Morning'
    );
    expect(voucherTypesTable(data).rows.map((row) => row[0])).toContain(
      'A Type Nobody Defined Before'
    );
  });
});

describe('the detail tabs', () => {
  it('reads a structure off the ledger entry, keyed back to the voucher', () => {
    const data = companyData({
      vouchers: [
        voucher({
          entries: [
            {
              ledgerName: 'ACME Ltd',
              amount: money('-1000.00'),
              side: 'debit',
              nested: {
                'BILLALLOCATIONS.LIST': [{ fields: { NAME: 'INV-1', BILLTYPE: 'New Ref' } }],
              },
            },
          ],
        }),
      ],
    });

    const table = nestedStructureTables(data).find((t) => t.title === 'Bill allocations');
    expect(table?.rows).toHaveLength(1);
    expect(table?.rows[0]).toContain('ACME Ltd');
    expect(table?.rows[0]).toContain('guid-1');
    expect(table?.columns.map((c) => c.header)).toContain('BILLTYPE');
    // The structure hangs off the LEDGER LINE, and the description has to say so
    // or the Ledger column reads as if it belonged to the voucher.
    expect(table?.description).toMatch(/hangs off the LEDGER LINE/);
  });

  it('gives no tab at all to a structure the company does not record', () => {
    // The tabs are DISCOVERED, so a company that has never used bill-wise
    // accounting gets no bill allocation tab — rather than an empty one that
    // invites the reader to wonder whether the read failed.
    const titles = nestedStructureTables(companyData()).map((table) => table.title);
    expect(titles).toEqual([]);
  });

  it('DISCOVERS a structure nobody listed, at any depth', () => {
    // The bug this pins, found live on 2026-08-20: the detail tabs were a
    // hardcoded list of five tag sets, read one level deep. A company carrying
    // BATCHALLOCATIONS.LIST *inside* its inventory entries — which is where the
    // GODOWN on a stock movement lives — had all 42 of them dropped, along with
    // five voucher-level structures nobody had thought to name.
    const data = companyData({
      vouchers: [
        voucher({
          nested: {
            'ALLINVENTORYENTRIES.LIST': [
              {
                fields: { STOCKITEMNAME: 'Widget' },
                nested: {
                  'BATCHALLOCATIONS.LIST': [
                    { fields: { GODOWNNAME: 'Main Store', BATCHNAME: 'B-1' } },
                  ],
                },
              },
            ],
            'INVOICEDELNOTES.LIST': [{ fields: { BASICSHIPDELIVERYNOTE: 'DN-7' } }],
          },
        }),
      ],
    });

    const titles = nestedStructureTables(data).map((table) => table.title);
    expect(titles).toContain('Inventory lines');
    // Two levels down, and previously invisible.
    expect(titles).toContain('Batch and godown');
    // Never named anywhere in the code, and still gets a tab.
    expect(titles).toContain('Delivery notes');
  });

  it('gives every tab a unique name, since a duplicate breaks the whole file', () => {
    const data = companyData({
      vouchers: [
        voucher({
          nested: {
            'ALLINVENTORYENTRIES.LIST': [{ fields: { A: '1' } }],
            'INVENTORYENTRIES.LIST': [{ fields: { A: '2' } }],
          },
        }),
      ],
    });
    const titles = nestedStructureTables(data).map((table) => table.title);
    // Both map to the friendly name "Inventory lines"; Excel refuses to OPEN a
    // workbook with two sheets of one name, so this is not cosmetic.
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("labels Tally's own plumbing and sends it to the END of the tab order", () => {
    // Found by discovery on live data: PFTDLVERSIONINFO (571 rows of TDL version
    // metadata) and UDF structures identified only by a numeric id. Kept for
    // completeness — 0.4% of the file, and meaningful to whoever configured
    // them — but they must not sit between two tabs somebody needs.
    const data = companyData({
      vouchers: [
        voucher({
          nested: {
            'PFTDLVERSIONINFO.LIST': [{ fields: { VERSION: '1' } }],
            'UDF:_UDF_553668230.LIST': [{ fields: { VALUE: 'x' } }],
            'ZZZREALDATA.LIST': [{ fields: { A: '1' } }],
          },
        }),
      ],
    });

    const tables = nestedStructureTables(data);
    const titles = tables.map((table) => table.title);

    // Real data first, even though its tag sorts last alphabetically.
    expect(titles[0]).toBe('Zzzrealdata');
    // And the plumbing says what it is, so nobody answers a question from it.
    const plumbing = tables.filter((table) => /PLUMBING/.test(table.description));
    expect(plumbing).toHaveLength(2);
    expect(plumbing[0]?.description).toMatch(/Not something to answer an accounting question/);
  });

  it("keeps Tally's own tag when the structure has no friendly name", () => {
    const data = companyData({
      vouchers: [voucher({ nested: { 'SOMETHINGNEW.LIST': [{ fields: { X: '1' } }] } })],
    });
    // Inventing a name for a structure nobody has looked at would assert a
    // meaning. The tag is honest.
    expect(nestedStructureTables(data).map((t) => t.title)).toContain('Somethingnew');
  });
});

describe('the cost centres and godowns a company actually uses', () => {
  it('builds the list from allocations, since the master lists are unreachable', () => {
    const data = companyData({
      vouchers: [
        voucher({
          nested: {
            'ALLINVENTORYENTRIES.LIST': [
              {
                fields: {},
                nested: {
                  'BATCHALLOCATIONS.LIST': [
                    { fields: { GODOWNNAME: 'Main Store', BATCHNAME: 'B-1' } },
                    { fields: { GODOWNNAME: 'Main Store', BATCHNAME: 'B-2' } },
                  ],
                },
              },
            ],
          },
          entries: [
            {
              ledgerName: 'Rent',
              amount: money('-100.00'),
              side: 'debit',
              nested: {
                'CATEGORYALLOCATIONS.LIST': [
                  {
                    fields: { CATEGORY: 'Departments' },
                    nested: {
                      'COSTCENTREALLOCATIONS.LIST': [{ fields: { NAME: 'Sales team' } }],
                    },
                  },
                ],
              },
            },
          ],
        }),
      ],
    });

    const rows = usedMastersTable(data).rows.map((row) => `${String(row[0])}: ${String(row[1])}`);
    expect(rows).toContain('Cost centre: Sales team');
    expect(rows).toContain('Cost category: Departments');
    expect(rows).toContain('Godown: Main Store');
    expect(rows).toContain('Batch: B-1');

    // Counted, so a name used once and a name used everywhere are told apart.
    const store = usedMastersTable(data).rows.find((row) => row[1] === 'Main Store');
    expect(store?.[2]).toBe(2);
  });

  it('says plainly that absence means UNUSED, not non-existent', () => {
    const table = usedMastersTable(companyData());
    expect(table.description).toMatch(/NOT the master lists/);
    expect(table.description).toMatch(/Absence here means UNUSED, never/);
    expect(table.emptyMeans).toMatch(/may still have such masters defined and unused/);
  });
});

describe('the Manifest', () => {
  const data = companyData();
  const body = [trialBalanceTable(data), vouchersTable(data)];
  const manifest = manifestTable(data, body, 'the books changed since the last export');
  const detail = manifest.rows.map((row) => String(row[2])).join('\n');

  it("carries Tally's exact company name", () => {
    expect(detail).toContain('EXAMPLE TRADING PRIVATE LIMITED');
  });

  it('says how the currency was established, not just what it is', () => {
    expect(detail).toContain('USD');
    expect(detail).toMatch(/TallyPrime reported this symbol/i);
  });

  it('states the span the vouchers ACTUALLY cover, measured from the rows', () => {
    // Measured from the data rather than restated from the request: a book year
    // that timed out is excluded, and the requested period would still claim it.
    expect(detail).toMatch(/Dates actually seen on vouchers/i.test(detail) ? /./ : /never/);
    expect(detail).toMatch(/2026-07-15 to 2026-07-15/);
    expect(detail).toMatch(/2 voucher\(s\)/);
  });

  it('says the statements cover a DIFFERENT period from the vouchers', () => {
    // The trap this exists to prevent: tying a trial balance to a voucher
    // history that runs years further back.
    expect(detail).toMatch(/Period the STATEMENT tabs cover/i.test(detail) ? /./ : /never/);
    expect(detail).toMatch(/Do not tie a statement to the whole voucher history/);
  });

  it('says plainly when no vouchers are present at all', () => {
    const empty = manifestTable(companyData({ vouchers: [] }), [], 'x')
      .rows.map((row) => String(row[2]))
      .join(' ');
    expect(empty).toMatch(/NO VOUCHERS ARE PRESENT/);
    // And does not let that be read as "this company does not trade".
    expect(empty).toMatch(/check the warnings below for a book year that could not be read/);
  });

  it('carries the as-at stamp and says it is not "now"', () => {
    expect(detail).toContain('2026-08-19T12:00:00.000Z');
    expect(detail).toMatch(/It is NOT "now"/);
  });

  it('reproduces every warning verbatim', () => {
    expect(detail).toContain('A warning TallyPrime produced during this run.');
  });

  it('gives a row count per tab, so a truncated export is detectable', () => {
    const counts = manifest.rows.filter((row) => row[0] === 'Row count');
    expect(counts.map((row) => row[1])).toEqual(['Trial balance', 'Vouchers']);
    expect(counts[1]?.[2]).toBe(2);
  });

  it('says which flags to exclude for a question about money', () => {
    expect(detail).toMatch(/exclude rows where Cancelled, Optional, Order voucher or/i);
  });

  it('states the debit sign convention and that nothing was recomputed', () => {
    expect(detail).toMatch(/Debit balances arrive NEGATIVE/);
    expect(detail).toMatch(/Nothing in this workbook was recomputed/);
  });

  it('warns against Save as Google Sheets', () => {
    expect(detail).toMatch(/SEPARATE native copy the exporter will never touch again/);
  });

  it('says it cannot confirm Google Drive uploaded anything', () => {
    expect(detail).toMatch(/cannot confirm Google Drive uploaded/i);
  });

  it('says a label that was merely inferred is not comparable', () => {
    const inferred = companyData({
      currency: { label: 'INR', source: 'derived-from-country', comparable: false },
    });
    const text = manifestTable(inferred, [], 'x')
      .rows.map((row) => String(row[2]))
      .join('\n');
    expect(text).toMatch(/INFERRED from the company's country/);
    expect(text).toMatch(/Never subtract across companies/);
  });
});

describe('the float64 round-trip check', () => {
  it('finds nothing on ordinary two-decimal money', () => {
    expect(roundTripFailures([trialBalanceTable(companyData())])).toEqual([]);
  });

  it('flags a value a spreadsheet cannot hold, naming the tab and column', () => {
    const data = companyData({
      trialBalance: {
        ...companyData().trialBalance,
        // 20 significant digits: float64 holds about 15.
        rows: [{ name: 'Odd', debit: money('1234567890.12345678901'), credit: null }],
      },
    });

    const failures = roundTripFailures([trialBalanceTable(data)]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('Trial balance');
    expect(failures[0]).toContain('"Debit"');
  });

  it('reaches the Manifest when it fires', () => {
    const data = companyData({
      trialBalance: {
        ...companyData().trialBalance,
        rows: [{ name: 'Odd', debit: money('1234567890.12345678901'), credit: null }],
      },
    });
    const detail = manifestTable(data, [trialBalanceTable(data)], 'x')
      .rows.map((row) => String(row[2]))
      .join('\n');
    expect(detail).toMatch(/1 amount\(s\)/);
  });
});

describe('the Contents tab', () => {
  it('says what an empty tab MEANS rather than leaving a blank', () => {
    // A company with no receivables: the tab is present and empty, and the
    // Contents row has to say that is an answer rather than a failed read.
    const empty = receivablesTable(
      companyData({ receivables: { ...companyData().receivables, rows: [] } })
    );
    expect(empty.rows).toHaveLength(0);
    const contents = contentsTable([empty]);
    expect(String(contents.rows[0]?.[2])).toMatch(/EMPTY: /);
  });

  it('lists a row count per tab', () => {
    const contents = contentsTable([trialBalanceTable(companyData())]);
    expect(contents.rows[0]?.[1]).toBe(1);
  });
});

describe('what is deliberately absent', () => {
  it('names prior years, the edit log and budgets, each with a reason', () => {
    const rows = notInThisWorkbookTable().rows.map((row) => String(row[0]));
    expect(rows).toEqual(
      expect.arrayContaining([
        'The edit log / audit trail',
        'Budgets',
        'Cost centre, cost category and godown MASTER lists',
        'Cost Centre Summary report',
        'The licence edition',
      ])
    );
    // Prior years are NO LONGER absent — they are read from the Voucher
    // Register report. Claiming otherwise would send somebody back to Tally
    // for history the workbook already has.
    expect(rows).not.toContain('Vouchers from earlier financial years');
    for (const row of notInThisWorkbookTable().rows) {
      expect(String(row[1]).length).toBeGreaterThan(40);
    }
  });
});

describe('sheet names', () => {
  it('strips the characters Excel refuses, which would break the whole file', () => {
    expect(sheetName('Profit / Loss [2026]')).toBe('Profit Loss 2026');
  });

  it('caps at 31 characters', () => {
    expect(sheetName('A'.repeat(40))).toHaveLength(31);
  });
});

describe('receivables', () => {
  it('carries the unaged amounts as columns rather than dropping them', () => {
    const headers = receivablesTable(companyData()).columns.map((c) => c.header);
    expect(headers).toContain('Could not be aged (no date)');
    expect(headers).toContain('On account (no bill reference)');
  });
});
