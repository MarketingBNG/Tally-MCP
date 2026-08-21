import { Decimal } from 'decimal.js';
import type { CellValue, Table } from './tables.js';

/**
 * The same tables as plain text, one file per tab.
 *
 * ## Why this exists alongside the workbook
 *
 * A `.xlsx` is a ZIP, so a connector hands it to a reader as **base64**.
 * Measured on this project's own output: the current-year workbook is 261KB on
 * disk, 348KB base64, roughly **89,000 tokens** to read raw — and the full
 * history is about 476,000, larger than most context windows before a single
 * figure has been looked at. Reported from a real audit session, the file could
 * not be held in context at all and had to be written to disk and decoded
 * separately.
 *
 * The cost is not the network. It is that a binary must arrive whole before any
 * of it can be read. A CSV per tab inverts that: a trial-balance question fetches
 * a nine-row text file of well under a thousand tokens instead of the entire
 * workbook.
 *
 * The workbook stays, and stays the thing a person opens — tabs, filters,
 * frozen headers and number formats are what a spreadsheet is for, and a CSV
 * has none of them. These files are for a reader that wants one table.
 *
 * ## One place this is BETTER than the workbook
 *
 * Precision. Excel stores numbers as float64, which is why the workbook carries
 * a round-trip check listing any amount that cannot survive the trip. A CSV
 * carries the decimal string exactly as TallyPrime sent it, so that class of
 * loss does not arise here at all.
 */

/**
 * Quote a field per RFC 4180.
 *
 * A field is quoted only when it has to be — a comma, a quote, or a line break
 * in it — because quoting everything makes the files noticeably larger and the
 * whole point of them is to be small. An embedded quote is doubled, which is
 * the one escaping rule CSV has.
 */
function quote(field: string): string {
  if (!/[",\r\n]/.test(field)) return field;
  return `"${field.replace(/"/g, '""')}"`;
}

/** One cell as text. */
function render(value: CellValue): string {
  if (value === null || value === undefined) return '';

  // FULL precision, not the float64 the spreadsheet is limited to. This is the
  // figure TallyPrime sent.
  if (value instanceof Decimal) return value.toString();

  // ISO, always. A locale-formatted date in a text file is the 03/04 ambiguity
  // with nothing to disambiguate it.
  if (value instanceof Date) return value.toISOString().slice(0, 10);

  return String(value);
}

/** One table as a CSV document, header row included. */
export function toCsv(table: Table): string {
  const lines = [table.columns.map((column) => quote(column.header)).join(',')];
  for (const row of table.rows) {
    lines.push(row.map((cell) => quote(render(cell))).join(','));
  }
  // Trailing newline: a text file without one is a minor annoyance in every
  // tool that reads it line by line.
  return `${lines.join('\n')}\n`;
}

/**
 * A filename for a tab.
 *
 * Tab titles are already safe for a sheet name, which is a stricter rule than a
 * filename — so this only has to add the extension and guard the one character
 * a sheet name permits and a path does not.
 */
export function csvFileName(title: string): string {
  return `${title.replace(/[\\/:*?"<>|]/g, '-')}.csv`;
}

/**
 * The index a reader fetches FIRST.
 *
 * Without it, choosing which table to fetch means either guessing at filenames
 * or fetching the workbook to find out — which is the cost this whole set of
 * files exists to avoid. So the index is deliberately tiny and carries the two
 * things needed to choose: how many rows a table has, and what it holds.
 */
export function csvIndex(tables: readonly Table[]): string {
  const index: Table = {
    title: 'INDEX',
    description: '',
    columns: [
      { header: 'File', kind: 'text' },
      { header: 'Rows', kind: 'count' },
      { header: 'Approx KB', kind: 'count' },
      { header: 'What it holds', kind: 'text' },
    ],
    rows: tables.map((table) => [
      csvFileName(table.title),
      table.rows.length,
      Math.max(1, Math.round(toCsv(table).length / 1024)),
      table.rows.length === 0 && table.emptyMeans !== undefined
        ? `${table.description}  —  EMPTY: ${table.emptyMeans}`
        : table.description,
    ]),
  };

  return toCsv(index);
}
