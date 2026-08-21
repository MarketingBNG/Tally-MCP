import ExcelJS from 'exceljs';
import { Decimal } from 'decimal.js';
import { SERVER_VERSION } from '../version.js';
import { sheetName, type CellValue, type Column, type Table } from './tables.js';

/**
 * Writing the tables into an .xlsx.
 *
 * ## Four details decide whether the figures are right
 *
 * - **Amounts as NUMBERS with an explicit `#,##0.00` format**, so a column can
 *   be summed. Text that looks like money cannot.
 * - **Excel stores numbers as float64; our amounts are `decimal.js`.** Any
 *   amount whose decimal string does not round-trip exactly is listed on the
 *   Manifest — see `roundTripFailures`. On ordinary two-decimal money that list
 *   is empty; when it is not, the workbook says so rather than quietly
 *   disagreeing with the books.
 * - **Dates as real dates with an explicit `yyyy-mm-dd` format**, so no locale
 *   reads 03/04 as March.
 * - **Text cells written as text**, so a ledger name beginning `=` or `-` is
 *   never a formula. This is the class of bug that silently changes a figure,
 *   and it has a test.
 *
 * ## Why a .xlsx and not a .csv per table
 *
 * A `.xlsx` opens directly in Google Sheets with tabs intact, and Claude can
 * read it through the Google Drive connector. Nothing needs importing, and one
 * file per company keeps a client's books in one place.
 */

const AMOUNT_FORMAT = '#,##0.00';
const DATE_FORMAT = 'yyyy-mm-dd';

/** Excel's hard ceiling. Stated here because the detail tabs would hit it first. */
export const MAX_ROWS_PER_SHEET = 1_048_576;

/**
 * Write one cell so it reads back as what it is.
 *
 * The `text` branch is the load-bearing one. `exceljs` writes a JavaScript
 * string as a string cell, so a ledger name of `=SUM(A1)` lands as text rather
 * than as a formula — but that is a property of the library rather than of this
 * code, so it is asserted in a test instead of assumed.
 */
function writeCell(cell: ExcelJS.Cell, value: CellValue, kind: Column['kind']): void {
  // Null is TallyPrime reporting nothing. It stays EMPTY: writing a zero here
  // would invent a figure, and an empty cell is the honest representation.
  if (value === null || value === undefined) return;

  switch (kind) {
    case 'amount': {
      const decimal = value instanceof Decimal ? value : new Decimal(String(value));
      cell.value = decimal.toNumber();
      cell.numFmt = AMOUNT_FORMAT;
      return;
    }
    case 'count': {
      cell.value = typeof value === 'number' ? value : Number(value);
      cell.numFmt = '0';
      return;
    }
    case 'date': {
      if (!(value instanceof Date)) {
        cell.value = String(value);
        return;
      }
      cell.value = value;
      cell.numFmt = DATE_FORMAT;
      return;
    }
    default:
      // Everything else — text, flags, and Tally's timezone-less timestamps —
      // is written as a string on purpose. A timestamp turned into a Date would
      // acquire a timezone nobody recorded.
      cell.value = value instanceof Decimal ? value.toString() : String(value);
  }
}

/** Column widths that make a tab readable without anyone dragging a divider. */
function widthFor(column: Column, rows: readonly CellValue[][], index: number): number {
  let longest = column.header.length;
  // Sampled, not exhaustive: a 200,000-row tab does not deserve a full scan to
  // choose a column width, and the first rows are representative enough.
  const sample = Math.min(rows.length, 200);
  for (let i = 0; i < sample; i += 1) {
    const value = rows[i]?.[index];
    if (value === null || value === undefined) continue;
    const text = value instanceof Date ? DATE_FORMAT : String(value);
    if (text.length > longest) longest = text.length;
  }
  return Math.min(Math.max(longest + 2, 10), 60);
}

/** One tab. */
function addSheet(book: ExcelJS.Workbook, table: Table): void {
  const sheet = book.addWorksheet(sheetName(table.title), {
    // A frozen header row and an autofilter, on every tab. Both are the
    // difference between a spreadsheet somebody can use and a wall of rows.
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = table.columns.map((column, index) => ({
    header: column.header,
    key: `c${String(index)}`,
    width: widthFor(column, table.rows, index),
  }));

  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', wrapText: true };

  for (const row of table.rows) {
    const added = sheet.addRow([]);
    row.forEach((value, index) => {
      writeCell(added.getCell(index + 1), value, table.columns[index]?.kind ?? 'text');
    });
  }

  // Only where there is something to filter. An autofilter over a header row
  // with no data below it is a control that does nothing.
  if (table.rows.length > 0 && table.columns.length > 0) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: table.columns.length },
    };
  }
}

/**
 * Write a workbook to a path.
 *
 * The caller decides the path — including writing to a temp name and renaming
 * over the target, which is how a half-written workbook never reaches Drive.
 * Nothing here knows about that; it writes the file it was given.
 */
export async function writeWorkbook(
  path: string,
  tables: readonly Table[],
  meta: { company: string; asOf: string }
): Promise<void> {
  const book = new ExcelJS.Workbook();
  book.creator = `tally-mcp ${SERVER_VERSION}`;
  book.created = new Date(meta.asOf);
  book.modified = new Date(meta.asOf);
  // Shown in the file's properties, so the company survives a rename of the file.
  book.description = `TallyPrime export for ${meta.company}, as at ${meta.asOf}. Generated file — replaced on every run.`;

  for (const table of tables) {
    if (table.rows.length > MAX_ROWS_PER_SHEET - 1) {
      throw new Error(
        `The "${table.title}" tab needs ${String(table.rows.length)} rows and a spreadsheet ` +
          `holds ${String(MAX_ROWS_PER_SHEET - 1)}. Nothing was written, because a workbook ` +
          'silently missing rows would look complete.\n\n' +
          'What to do: this company has outgrown a single-file export. Send this message to ' +
          'whoever set this up.'
      );
    }
    addSheet(book, table);
  }

  await book.xlsx.writeFile(path);
}
