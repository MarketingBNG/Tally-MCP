import { foldUniformFields } from '../../utils/uniformFields.js';
import { Decimal } from 'decimal.js';
import type { Money } from '../../utils/numbers.js';
import type { CompanyData } from '../collect.js';

/**
 * Turning normalised records into sheets — and nothing else.
 *
 * ## Pure on purpose
 *
 * No TallyPrime access, no filesystem, no clock. Every function here takes
 * records and returns `{ title, columns, rows }`, so what a column MEANS can be
 * tested against hand-built records rather than against whatever a live company
 * happens to hold. That is the difference between a test that proves the
 * `Voucher entries` debit column is a debit and a test that proves the export
 * did not crash.
 *
 * ## Human-readable is a requirement, not a polish item
 *
 * Real column headings, not Tally's tag names: `Voucher number`, never
 * `VOUCHERNUMBER`. Someone opens this in Google Sheets and reads it; so does
 * Claude, and a heading is the only thing telling either of them what a column
 * is.
 */

/**
 * The table shape every builder produces, and the cell helpers they share.
 *
 * Split out of tables.ts at 1,309 lines. Nothing here knows what a ledger or a
 * voucher is: it is the vocabulary — a column, a cell, a sheet name — that the
 * builders speak.
 */

/** What one cell can hold. `null` is "Tally reported nothing", never zero. */
export type CellValue = string | number | Decimal | Date | boolean | null;

/** How a column is written into the workbook, and therefore how it reads back. */
export type ColumnKind =
  /** Text, forced to text so a ledger name beginning `=` is never a formula. */
  | 'text'
  /** Money. A number with `#,##0.00`, so a column can be summed. */
  | 'amount'
  /** A plain count. A number with no decimals. */
  | 'count'
  /** A real date with `yyyy-mm-dd`, so no locale reads 03/04 as March. */
  | 'date'
  /** A timestamp Tally wrote, kept as TEXT — see `Voucher entries` below. */
  | 'stamp'
  /** Yes/No. Written as text so a filter shows both values. */
  | 'flag';

export interface Column {
  header: string;
  kind: ColumnKind;
}

export interface Table {
  /** The sheet name. Must already satisfy Excel's rules — see `sheetName`. */
  title: string;
  /** One line for the Contents tab. What this tab holds, in plain words. */
  description: string;
  columns: Column[];
  rows: CellValue[][];
  /**
   * Said on the Contents tab when the tab is empty, so an empty tab is an
   * ANSWER rather than a gap. Null where emptiness needs no explanation.
   */
  emptyMeans?: string;
}

/**
 * Excel's sheet-name rules, applied once.
 *
 * 31 characters, and none of `[ ] : * ? / \`. A name breaking either is not a
 * warning in Excel — the file fails to open, which is the whole workbook lost
 * over a tab title.
 */
export function sheetName(title: string): string {
  const cleaned = title.replace(/[[\]:*?/\\]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return cleaned.length > 31 ? cleaned.slice(0, 31).trim() : cleaned;
}

/**
 * Compare names the way a person reads a list: case-insensitively, but with a
 * deterministic tiebreak so two names differing only in case never swap places
 * between runs.
 */
export function byName(a: string | null, b: string | null): number {
  const left = a ?? '';
  const right = b ?? '';
  const natural = left.localeCompare(right, 'en', { sensitivity: 'base', numeric: true });
  if (natural !== 0) return natural;
  // Exact comparison as the tiebreak. Without it `Sales` and `SALES` order
  // arbitrarily, and arbitrarily can mean differently on the next run.
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The voucher order every voucher-derived tab uses.
 *
 * Shared on purpose. `Vouchers`, `Voucher entries` and the five detail tabs all
 * key back to the same GUIDs, so a reader scrolling two tabs side by side is
 * entitled to find them in the same sequence — and three separate sorts would
 * eventually disagree.
 *
 * Date first, because that is how anybody reads a register. GUID last as the
 * tiebreak, since it is the only field guaranteed unique: without it, two
 * vouchers sharing a date and number would order arbitrarily.
 */
export function orderedVouchers(vouchers: readonly CompanyData['vouchers'][number][]): CompanyData['vouchers'] {
  return [...vouchers].sort((a, b) => {
    const date = (a.date ?? '').localeCompare(b.date ?? '');
    if (date !== 0) return date;
    const number = byName(a.voucherNumber, b.voucherNumber);
    if (number !== 0) return number;
    return byName(a.guid, b.guid);
  });
}

/** A `Money` as a decimal, or null. Null is not zero and must not become one. */
export function amount(money: Money | null | undefined): Decimal | null {
  if (money === null || money === undefined) return null;
  try {
    return new Decimal(money.amount);
  } catch {
    // An amount Tally sent that will not parse is reported as absent rather
    // than as zero. A zero here would be a figure nobody wrote.
    return null;
  }
}

/** An ISO date string as a real Date, or null. */
export function isoDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Tally's Yes/No, as the words rather than a checkbox. */
export function flag(value: boolean): string {
  return value ? 'Yes' : 'No';
}

/**
 * Voucher-level fields that vary on THIS company, discovered rather than listed.
 *
 * Which fields a company populates is a property of the company — one with GST
 * configured carries GST fields, a payroll company carries payroll fields — so
 * the columns cannot be hardcoded. The uniform ones are relocated to the
 * `Tally defaults` tab, which is what makes this a fold rather than a filter.
 */
export function varyingFieldKeys(records: readonly { fields?: Record<string, string> }[]): {
  keys: string[];
  uniform: Record<string, string>;
} {
  const fold = foldUniformFields(
    records,
    (record) => record.fields,
    (record, fields) => ({ ...record, fields })
  );

  const keys = new Set<string>();
  for (const record of fold.records) {
    for (const key of Object.keys(record.fields ?? {})) keys.add(key);
  }

  return { keys: [...keys].sort(), uniform: fold.uniformFields };
}
