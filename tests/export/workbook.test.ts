import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { Decimal } from 'decimal.js';
import { writeWorkbook } from '../../src/export/workbook.js';
import type { Table } from '../../src/export/tables.js';

/**
 * The workbook as it lands on disk.
 *
 * These go through a real .xlsx and read it back, because every one of them is
 * about what a SPREADSHEET does with a value rather than about what this code
 * intended. A ledger name beginning `=` is the class of bug that silently
 * changes a figure, and no amount of reading the writing code proves it.
 */

let folder: string;
let path: string;

const table: Table = {
  title: 'Books',
  description: 'x',
  columns: [
    { header: 'Ledger', kind: 'text' },
    { header: 'Amount', kind: 'amount' },
    { header: 'Date', kind: 'date' },
    { header: 'Lines', kind: 'count' },
    { header: 'Cancelled', kind: 'flag' },
    { header: 'Last written', kind: 'stamp' },
  ],
  rows: [
    // A ledger name that is a formula, and one that Excel would read as a
    // negative number. Both are real ledger names somebody could type.
    ['=SUM(A1:A9)', new Decimal('1234.56'), new Date('2026-07-15T00:00:00Z'), 2, 'No', '2026-07-16T09:30:00'],
    ['-Opening adjustment', new Decimal('-99.99'), new Date('2026-03-04T00:00:00Z'), 1, 'Yes', null],
    // Null must stay EMPTY. A zero here would be a figure nobody wrote.
    ['Nothing reported', null, null, 0, 'No', null],
  ],
};

async function readBack(): Promise<ExcelJS.Worksheet> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(path);
  const sheet = book.getWorksheet('Books');
  if (sheet === undefined) throw new Error('the Books sheet is missing');
  return sheet;
}

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'tally-export-'));
  path = join(folder, 'test.xlsx');
  await writeWorkbook(path, [table], { company: 'EXAMPLE LTD', asOf: '2026-08-19T12:00:00.000Z' });
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('text cells', () => {
  it('keeps a ledger name beginning "=" as TEXT, never a formula', async () => {
    const cell = (await readBack()).getCell('A2');
    expect(cell.type).toBe(ExcelJS.ValueType.String);
    expect(cell.value).toBe('=SUM(A1:A9)');
    expect(cell.formula).toBeUndefined();
  });

  it('keeps a name beginning "-" as text rather than a number', async () => {
    const cell = (await readBack()).getCell('A3');
    expect(cell.value).toBe('-Opening adjustment');
    expect(typeof cell.value).toBe('string');
  });

  it('keeps a Tally timestamp as text, since it carries no timezone', async () => {
    const cell = (await readBack()).getCell('F2');
    expect(cell.value).toBe('2026-07-16T09:30:00');
  });
});

describe('amounts', () => {
  it('lands as a number so the column can be summed', async () => {
    const cell = (await readBack()).getCell('B2');
    expect(typeof cell.value).toBe('number');
    expect(cell.value).toBeCloseTo(1234.56, 6);
  });

  it('carries an explicit money format', async () => {
    expect((await readBack()).getCell('B2').numFmt).toBe('#,##0.00');
  });

  it('preserves a negative', async () => {
    expect((await readBack()).getCell('B3').value).toBeCloseTo(-99.99, 6);
  });
});

describe('dates', () => {
  it('lands as a real date, not a string', async () => {
    const cell = (await readBack()).getCell('C2');
    expect(cell.value).toBeInstanceOf(Date);
  });

  it('carries an unambiguous format, so no locale reads 03/04 as March', async () => {
    // 4 March. Written with an explicit format precisely so this cannot be read
    // as 3 April by a reader in another locale.
    const cell = (await readBack()).getCell('C3');
    expect(cell.numFmt).toBe('yyyy-mm-dd');
    expect((cell.value as Date).toISOString()).toContain('2026-03-04');
  });
});

describe('absence', () => {
  it('leaves a null amount EMPTY rather than writing a zero', async () => {
    const cell = (await readBack()).getCell('B4');
    expect(cell.value).toBeNull();
  });

  it('leaves a null date empty', async () => {
    expect((await readBack()).getCell('C4').value).toBeNull();
  });
});

describe('usability', () => {
  it('freezes the header row and turns on the autofilter', async () => {
    const sheet = await readBack();
    expect(sheet.views[0]?.state).toBe('frozen');
    expect(sheet.autoFilter).toBeTruthy();
  });

  it('sets a column width rather than leaving everything at the default', async () => {
    const sheet = await readBack();
    expect(sheet.getColumn(1).width).toBeGreaterThan(0);
  });

  it('bolds the header row', async () => {
    expect((await readBack()).getRow(1).font?.bold).toBe(true);
  });
});

describe('refusing to ship something wrong', () => {
  it('refuses a tab above the spreadsheet row limit rather than truncating', async () => {
    const huge: Table = {
      title: 'Huge',
      description: 'x',
      columns: [{ header: 'A', kind: 'text' }],
      // Not actually allocated — the guard is checked from the length.
      rows: { length: 2_000_000 } as unknown as Table['rows'],
    };

    await expect(
      writeWorkbook(join(folder, 'huge.xlsx'), [huge], {
        company: 'X',
        asOf: '2026-08-19T12:00:00.000Z',
      })
    ).rejects.toThrow(/would look complete/);
  });
});
