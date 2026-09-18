import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toCsv, csvIndex, csvFileName } from '../../src/export/csv.js';
import type { Table } from '../../src/export/tables.js';
import {
  findExportedCompany,
  listExportedCompanies,
  listExportedTables,
  parseCsv,
  readExportedTable,
} from '../../src/export/read.js';

/**
 * Reading the export back from the machine that wrote it.
 *
 * The reason this exists at all is a real failure: somebody choosing a folder
 * Google Drive does not sync got an export that ran perfectly and that Claude
 * could never open. Reading from disk removes the dependency — but only if the
 * reader and the writer genuinely agree.
 *
 * So these tests are written against the REAL writer (`toCsv`, `csvIndex`,
 * `csvFileName`) rather than against hand-typed CSV text. Hand-typed fixtures
 * would prove the parser parses what I imagined the exporter writes, which is
 * precisely the assumption that is worth nothing. If the two halves ever drift,
 * a round trip is what notices.
 */

const created: string[] = [];

afterAll(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tally-read-'));
  created.push(root);
  return root;
}

function table(title: string, columns: string[], rows: string[][]): Table {
  return {
    title,
    description: `${title} rows`,
    columns: columns.map((header) => ({ header, kind: 'text' as const })),
    rows,
  };
}

/**
 * Write a company folder the way the exporter does: a `Tables (CSV)` subfolder
 * holding an INDEX and one file per tab.
 */
function writeCompany(root: string, folderLabel: string, tables: Table[]): void {
  const csvFolder = join(root, folderLabel, 'Tables (CSV)');
  mkdirSync(csvFolder, { recursive: true });
  writeFileSync(join(csvFolder, 'INDEX.csv'), csvIndex(tables), 'utf8');
  for (const one of tables) {
    writeFileSync(join(csvFolder, csvFileName(one.title)), toCsv(one), 'utf8');
  }
}

/** A Manifest shaped like the real one: [section, label, value] per row. */
function manifest(company: string, asAt = '2026-09-17T18:05:00', currency = '$'): Table {
  return table(
    'Manifest',
    ['Section', 'Item', 'Value'],
    [
      ['Company', "Company (TallyPrime's own spelling — quote THIS, not the folder name)", company],
      ['Company', 'Currency', currency],
      ['Company', 'As at (last successful read from TallyPrime)', asAt],
    ]
  );
}

describe('parsing what the exporter writes', () => {
  it('keeps a field holding a comma in one column', () => {
    // The failure this guards is silent: split(',') would shift every later
    // column, producing amounts under the wrong headings on a table that still
    // looks perfectly well formed.
    const source = table(
      'Ledgers',
      ['Name', 'Balance'],
      [['Smith, Jones & Co', '1000.00']]
    );

    const [, row] = parseCsv(toCsv(source));

    expect(row).toEqual(['Smith, Jones & Co', '1000.00']);
  });

  it('keeps a field holding a quote and a newline intact', () => {
    // Narrations carry both. A parser that mishandles either would split one
    // voucher into two rows, and a row count is exactly what an auditor checks.
    const narration = 'Paid "on account"\nsecond line';
    const source = table('Vouchers', ['Narration'], [[narration]]);

    const rows = parseCsv(toCsv(source));

    expect(rows).toHaveLength(2);
    expect(rows[1]?.[0]).toBe(narration);
  });
});

describe('finding companies in the export folder', () => {
  it('reports the company by TallyPrime spelling, not by folder name', () => {
    const root = tempRoot();
    // The folder label is sanitised and truncated; the Manifest holds the real
    // name. Quoting the folder back at an accountant names their client wrongly.
    writeCompany(root, 'ACME Nutrition GmbH - (from 1-Jan-24)', [
      manifest('ACME Nutrition GmbH / Berlin: (from 1-Jan-24)'),
    ]);

    const [found] = listExportedCompanies(root);

    expect(found?.company).toBe('ACME Nutrition GmbH / Berlin: (from 1-Jan-24)');
    expect(found?.folder).toBe('ACME Nutrition GmbH - (from 1-Jan-24)');
  });

  it('carries the as-at stamp and the currency', () => {
    const root = tempRoot();
    writeCompany(root, 'Books', [manifest('Books Ltd', '2026-09-17T18:05:00', '€')]);

    const [found] = listExportedCompanies(root);

    // Both travel with the answer or a figure gets quoted as "now", in rupees.
    expect(found?.asAt).toBe('2026-09-17T18:05:00');
    expect(found?.currency).toBe('€');
  });

  it('ignores folders that are not exports', () => {
    const root = tempRoot();
    // The export folder is one a person picked. It may well hold their scans,
    // their working papers, last year's accounts.
    mkdirSync(join(root, 'Scans'), { recursive: true });
    mkdirSync(join(root, 'Working papers', 'Tables (CSV)'), { recursive: true });
    writeCompany(root, 'Real Co', [manifest('Real Co Ltd')]);

    const found = listExportedCompanies(root);

    expect(found.map((entry) => entry.company)).toEqual(['Real Co Ltd']);
  });

  it('returns nothing when the folder is missing rather than throwing', () => {
    // A network drive that is not connected today. The caller has to explain
    // that in context and fall back to TallyPrime, so it gets an empty answer
    // to interpret rather than an exception to catch.
    expect(listExportedCompanies(join(tempRoot(), 'not-here'))).toEqual([]);
    expect(listExportedCompanies(undefined)).toEqual([]);
    expect(listExportedCompanies('')).toEqual([]);
  });

  it('skips a folder whose Manifest carries no company name', () => {
    const root = tempRoot();
    writeCompany(root, 'Nameless', [table('Manifest', ['a', 'b', 'c'], [['x', 'y', 'z']])]);

    // Figures that cannot be attributed to a company are worse than none.
    expect(listExportedCompanies(root)).toEqual([]);
  });
});

describe('choosing which company to answer from', () => {
  it('matches a name regardless of case and surrounding spaces', () => {
    const root = tempRoot();
    writeCompany(root, 'Books', [manifest('Books Ltd')]);

    expect(findExportedCompany(root, '  books ltd ')?.company).toBe('Books Ltd');
  });

  it('answers unnamed only when exactly one company is present', () => {
    const root = tempRoot();
    writeCompany(root, 'One', [manifest('One Ltd')]);

    expect(findExportedCompany(root, undefined)?.company).toBe('One Ltd');

    writeCompany(root, 'Two', [manifest('Two Ltd')]);

    // Two sets of books and no name is not a question with an answer. Picking
    // the first would report the wrong client's figures under no name at all.
    expect(findExportedCompany(root, undefined)).toBeNull();
  });
});

describe('reading one table', () => {
  it('lists the tables from the INDEX with their row counts', () => {
    const root = tempRoot();
    const ledgers = table('Ledgers', ['Name'], [['A'], ['B'], ['C']]);
    writeCompany(root, 'Books', [manifest('Books Ltd'), ledgers]);

    const target = findExportedCompany(root, 'Books Ltd');
    const tables = listExportedTables(target!);

    expect(tables.find((entry) => entry.file === 'Ledgers.csv')?.rows).toBe(3);
  });

  it('round-trips the rows the exporter wrote', () => {
    const root = tempRoot();
    const ledgers = table(
      'Ledgers',
      ['Name', 'Balance'],
      [
        ['Smith, Jones & Co', '1000.00'],
        ['O"Brien', '-250.50'],
      ]
    );
    writeCompany(root, 'Books', [manifest('Books Ltd'), ledgers]);

    const target = findExportedCompany(root, 'Books Ltd');
    const read = readExportedTable(target!, 'Ledgers.csv');

    expect(read.columns).toEqual(['Name', 'Balance']);
    expect(read.rows).toEqual([
      ['Smith, Jones & Co', '1000.00'],
      ['O"Brien', '-250.50'],
    ]);
    expect(read.totalRows).toBe(2);
    expect(read.truncated).toBe(false);
  });

  it('pages a long table and says it was cut', () => {
    const root = tempRoot();
    const rows = Array.from({ length: 50 }, (_, i) => [`Row ${String(i)}`]);
    writeCompany(root, 'Books', [manifest('Books Ltd'), table('Entries', ['Name'], rows)]);

    const target = findExportedCompany(root, 'Books Ltd');
    const read = readExportedTable(target!, 'Entries.csv', { offset: 10, limit: 5 });

    expect(read.rows).toEqual([['Row 10'], ['Row 11'], ['Row 12'], ['Row 13'], ['Row 14']]);
    expect(read.totalRows).toBe(50);
    // The count reported is the FILE's, not the page's — otherwise a paged read
    // reports 5 entries on a company that has 50.
    expect(read.truncated).toBe(true);
  });

  it('refuses a filename that climbs out of the export folder', () => {
    const root = tempRoot();
    writeCompany(root, 'Books', [manifest('Books Ltd')]);
    writeFileSync(join(root, 'secret.csv'), 'a\n1\n', 'utf8');

    const target = findExportedCompany(root, 'Books Ltd');

    // Resolved through the INDEX, so a traversal is simply not a known table.
    expect(() => readExportedTable(target!, '..\\..\\secret.csv')).toThrow(/no table named/);
  });
});
