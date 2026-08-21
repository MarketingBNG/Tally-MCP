import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import { csvFileName, csvIndex, toCsv } from '../../src/export/csv.js';
import type { Table } from '../../src/export/tables.js';

/**
 * The CSVs a reader fetches one at a time.
 *
 * These exist because the workbook reaches a connector as base64 — measured at
 * ~89,000 tokens for the current-year file and ~476,000 for the full history,
 * before a single figure has been read. A CSV per tab turns a trial-balance
 * question into well under a thousand.
 *
 * So the tests here are about the two things that would make them useless: a
 * field that breaks the format, and a figure that arrives changed.
 */

function table(rows: Table['rows']): Table {
  return {
    title: 'Books',
    description: 'x',
    columns: [
      { header: 'Ledger', kind: 'text' },
      { header: 'Amount', kind: 'amount' },
      { header: 'Date', kind: 'date' },
    ],
    rows,
  };
}

describe('quoting', () => {
  it('quotes a field containing a comma, which is the whole hazard', () => {
    const csv = toCsv(table([['ACME, Inc.', new Decimal('10'), null]]));
    expect(csv.split('\n')[1]).toBe('"ACME, Inc.",10,');
  });

  it('doubles an embedded quote, the one escape CSV has', () => {
    const csv = toCsv(table([['The "Big" Co', null, null]]));
    expect(csv.split('\n')[1]).toBe('"The ""Big"" Co",,');
  });

  it('quotes a field with a line break, so one row stays one row', () => {
    // Tally narrations really do contain newlines.
    const csv = toCsv(table([['Paid\nin two parts', null, null]]));
    expect(csv).toContain('"Paid\nin two parts"');
    // The header plus one record, and the record's newline is inside quotes.
    expect(csv.trimEnd().split('\n')).toHaveLength(3);
  });

  it('leaves an ordinary field unquoted, because size is the point', () => {
    const csv = toCsv(table([['Cash', new Decimal('5'), null]]));
    expect(csv.split('\n')[1]).toBe('Cash,5,');
  });
});

describe('figures', () => {
  it('carries FULL precision, unlike the spreadsheet', () => {
    // The workbook has to round this to float64 and says so on its Manifest.
    // A text file has no such limit, so the figure Tally sent survives intact.
    const exact = '1234567890.12345678901';
    const csv = toCsv(table([['Odd', new Decimal(exact), null]]));
    expect(csv.split('\n')[1]).toBe(`Odd,${exact},`);
  });

  it('writes a date as ISO, never a locale format', () => {
    const csv = toCsv(table([['X', null, new Date('2026-03-04T00:00:00Z')]]));
    // 4 March. In a text file with no format to disambiguate it, 03/04 would be
    // a coin toss.
    expect(csv.split('\n')[1]).toBe('X,,2026-03-04');
  });

  it('leaves a null EMPTY rather than writing a zero', () => {
    const csv = toCsv(table([['Nothing reported', null, null]]));
    expect(csv.split('\n')[1]).toBe('Nothing reported,,');
  });

  it('does not mangle a ledger name that looks like a formula', () => {
    // A CSV has no formula concept, but a reader might paste it into one.
    const csv = toCsv(table([['=SUM(A1:A9)', null, null]]));
    expect(csv.split('\n')[1]).toBe('=SUM(A1:A9),,');
  });
});

describe('the index a reader fetches first', () => {
  const tables: Table[] = [
    table([['Cash', new Decimal('1'), null]]),
    {
      title: 'GST breakdown',
      description: 'GST detail.',
      columns: [{ header: 'A', kind: 'text' }],
      rows: [],
      emptyMeans: 'This company records no GST.',
    },
  ];

  it('names every file with its row count, so nothing has to be guessed', () => {
    const index = csvIndex(tables);
    expect(index).toContain('Books.csv,1');
    expect(index).toContain('GST breakdown.csv,0');
  });

  it('carries a size, so a reader can tell a big table from a small one', () => {
    expect(csvIndex(tables).split('\n')[0]).toBe('File,Rows,Approx KB,What it holds');
  });

  it('says what an empty table MEANS rather than leaving it blank', () => {
    expect(csvIndex(tables)).toContain('EMPTY: This company records no GST.');
  });
});

describe('filenames', () => {
  it('turns a tab title into a filename', () => {
    expect(csvFileName('Trial balance')).toBe('Trial balance.csv');
  });

  it('replaces a character a path cannot hold', () => {
    expect(csvFileName('Profit/Loss')).toBe('Profit-Loss.csv');
  });
});
