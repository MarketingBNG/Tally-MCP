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
import {
  amount,
  flag,
  type CellValue,
  type Column,
  type Table,
  byName,
  varyingFieldKeys,
} from './shared.js';

/**
 * The master tables, and the by-year statement series.
 *
 * Split out of tables.ts at 1,309 lines. One table per master collection, plus
 * the three statements rendered as a year-by-year series rather than a single
 * period.
 */

export function ledgersTable(data: CompanyData): Table {
  const { keys } = varyingFieldKeys(data.ledgers);

  return {
    title: 'Ledgers',
    description:
      'The ledger masters with every field that VARIES on this company. Fields holding one ' +
      'value on every ledger are on the Tally defaults tab — relocated, never dropped.',
    columns: [
      { header: 'Ledger', kind: 'text' },
      { header: 'Parent group', kind: 'text' },
      ...keys.map((key): Column => ({ header: key, kind: 'text' })),
    ],
    rows: [...data.ledgers].sort((a, b) => byName(a.name, b.name)).map((ledger) => [
      ledger.name,
      ledger.parent,
      ...keys.map((key) => ledger.fields?.[key] ?? null),
    ]),
  };
}

export function groupsTable(data: CompanyData): Table {
  return {
    title: 'Groups',
    description:
      'The chart of accounts. "Revenue group" is what makes a group a profit-and-loss group ' +
      'rather than a balance sheet one.',
    columns: [
      { header: 'Group', kind: 'text' },
      { header: 'Parent group', kind: 'text' },
      { header: 'Revenue group', kind: 'flag' },
      { header: 'Deemed positive in Tally', kind: 'flag' },
    ],
    rows: [...data.groups].sort((a, b) => byName(a.name, b.name)).map((group) => [
      group.name,
      group.parent,
      flag(group.isRevenue),
      flag(group.isDeemedPositive),
    ]),
  };
}

export function voucherTypesTable(data: CompanyData): Table {
  const rows: CellValue[][] = [];

  for (const type of [...data.voucherTypes].sort((a, b) => byName(a.name, b.name))) {
    if (type.numberingSeries.length === 0) {
      rows.push([type.name, type.parent, flag(type.isDeemedPositive), null, null, null, null]);
      continue;
    }
    for (const series of type.numberingSeries) {
      rows.push([
        type.name,
        type.parent,
        flag(type.isDeemedPositive),
        series.name,
        series.method,
        series.subMethod,
        flag(series.preventsDuplicates),
      ]);
    }
  }

  return {
    title: 'Voucher types',
    description:
      'One row per numbering series. "Family" is the built-in type this one derives from — a ' +
      'company may call its sales type anything, and only the family identifies it.',
    columns: [
      { header: 'Voucher type', kind: 'text' },
      { header: 'Family', kind: 'text' },
      { header: 'Deemed positive in Tally', kind: 'flag' },
      { header: 'Numbering series', kind: 'text' },
      { header: 'Numbering method', kind: 'text' },
      { header: 'Numbering sub-method', kind: 'text' },
      { header: 'Tally prevents duplicates', kind: 'flag' },
    ],
    rows,
  };
}

export function stockItemsTable(data: CompanyData): Table {
  const { keys } = varyingFieldKeys(data.stockItems);

  return {
    title: 'Stock items',
    description:
      'The stock masters. Quantities are strings WITH their unit, exactly as Tally formats ' +
      'them — a bare stock number without its unit is meaningless. Do not multiply quantity ' +
      'by rate; use the value column, which is Tally\'s own.',
    columns: [
      { header: 'Stock item', kind: 'text' },
      { header: 'Parent', kind: 'text' },
      { header: 'Base units', kind: 'text' },
      { header: 'Opening quantity', kind: 'text' },
      { header: 'Closing quantity', kind: 'text' },
      { header: 'Opening value', kind: 'amount' },
      { header: 'Closing value', kind: 'amount' },
      { header: 'Closing rate (rounded)', kind: 'text' },
      ...keys.map((key): Column => ({ header: key, kind: 'text' })),
    ],
    rows: [...data.stockItems].sort((a, b) => byName(a.name, b.name)).map((item) => [
      item.name,
      item.parent,
      item.baseUnits,
      item.openingBalance,
      item.closingBalance,
      amount(item.openingValue),
      amount(item.closingValue),
      item.closingRate,
      ...keys.map((key) => item.fields[key] ?? null),
    ]),
    emptyMeans:
      'This company does not maintain inventory. That is NOT a stock position of zero.',
  };
}

export function currenciesTable(data: CompanyData): Table {
  return {
    title: 'Currencies',
    description:
      'Every currency this company defines. The symbol may read "?" — TallyPrime substitutes ' +
      'it before the bytes leave, so the NAME column is the reliable one.',
    columns: [
      { header: 'Symbol', kind: 'text' },
      { header: 'Name', kind: 'text' },
      { header: 'Decimal places', kind: 'text' },
    ],
    rows: [...data.currencies].sort((a, b) => byName(a.name, b.name)).map((currency) => [
      currency.name,
      currency.formalName,
      currency.decimalPlaces,
    ]),
  };
}

export function closingStockTable(data: CompanyData): Table {
  return {
    title: 'Closing stock',
    description:
      `${data.closingStock.basis}, by ${data.closingStock.groupedBy}. A DIFFERENT BASIS from ` +
      'the Stock items tab, which reads the masters — say which you are quoting.',
    columns: [
      { header: data.closingStock.groupedBy, kind: 'text' },
      { header: 'Closing quantity', kind: 'text' },
      { header: 'Closing rate (rounded)', kind: 'text' },
      { header: 'Closing value', kind: 'amount' },
    ],
    rows: data.closingStock.rows.map((row) => [
      row.name,
      row.closingQuantity,
      row.closingRate,
      amount(row.closingValue),
    ]),
    emptyMeans:
      'This company does not maintain inventory. That is NOT a stock position of zero.',
  };
}

export function godownsTable(data: CompanyData): Table | null {
  if (data.godowns === null) return null;

  return {
    title: 'Godowns',
    description:
      `${data.godowns.basis}, by ${data.godowns.groupedBy}. Stock by storage location — the ` +
      'only location-wise view this interface can read.',
    columns: [
      { header: data.godowns.groupedBy, kind: 'text' },
      { header: 'Closing quantity', kind: 'text' },
      { header: 'Closing rate (rounded)', kind: 'text' },
      { header: 'Closing value', kind: 'amount' },
    ],
    rows: data.godowns.rows.map((row) => [
      row.name,
      row.closingQuantity,
      row.closingRate,
      amount(row.closingValue),
    ]),
    emptyMeans:
      'This company records no stock against any storage location. That is NOT a stock ' +
      'position of zero.',
  };
}

/**
 * One statement across every book year, with a Year column.
 *
 * ## Why a series rather than one tab per year
 *
 * Five years times three statements is fifteen tabs on a workbook that already
 * has thirty-five, and comparing them would mean scrolling between sheets. A
 * Year column makes "how did the gross margin move" a filter rather than a
 * hunt, and it keeps the tab count flat as the books get older.
 *
 * ## The row order is Tally's, within each year
 *
 * Same reason the single-year statement tabs are not sorted: the sequence IS the
 * document. So this groups by year — oldest first, the way a comparative is
 * read — and leaves each year's rows exactly as Tally presented them.
 *
 * A year TallyPrime could not serve is simply absent from the series, and the
 * warning saying so is on the Manifest. That is why the Year column matters
 * more than it looks: a missing year is visible as a gap in the values, not as
 * an empty row somebody has to notice.
 */
export function statementByYearTable(
  title: string,
  description: string,
  series: CompanyData['statementsByYear'],
  pick: (entry: CompanyData['statementsByYear'][number]) => CompanyData['trialBalance'] | null,
  columns: { header: string; from: (row: Record<string, Money | null>) => Money | null }[]
): Table {
  const rows: CellValue[][] = [];

  for (const entry of series) {
    const statement = pick(entry);
    if (statement === null) continue;

    for (const raw of statement.rows as (Record<string, Money | null> & { name: string })[]) {
      rows.push([
        `${entry.year.fromDate} to ${entry.year.toDate}`,
        entry.isCurrent ? 'Yes' : 'No',
        raw.name,
        ...columns.map((column) => amount(column.from(raw))),
      ]);
    }
  }

  return {
    title,
    description,
    columns: [
      { header: 'Book year', kind: 'text' },
      { header: 'Current year', kind: 'flag' },
      { header: 'Name', kind: 'text' },
      ...columns.map((column): Column => ({ header: column.header, kind: 'amount' })),
    ],
    rows,
    emptyMeans:
      'No book year could be read for this statement. That is a FAILURE rather than an absence ' +
      'of trading — check the Manifest warnings.',
  };
}

/** The three by-year series, with the columns each statement carries. */
export function statementsByYearTables(data: CompanyData): Table[] {
  const YEAR_NOTE =
    ' One row per line per BOOK YEAR, oldest first. Each year was requested with its own end ' +
    'date, which TallyPrime honours because a book year always ends on the 31st of a month. ' +
    'Figures for a prior year were NOT cross-checked against the ledger masters, because those ' +
    'describe the position today rather than then.';

  return [
    statementByYearTable(
      'Trial balance by year',
      "TallyPrime's own Trial Balance for every book year." + YEAR_NOTE,
      data.statementsByYear,
      (entry) => entry.trialBalance,
      [
        { header: 'Debit', from: (row) => row.debit ?? null },
        { header: 'Credit', from: (row) => row.credit ?? null },
      ]
    ),
    statementByYearTable(
      'Profit and loss by year',
      "TallyPrime's own Profit and Loss for every book year." + YEAR_NOTE,
      data.statementsByYear,
      (entry) => entry.profitLoss,
      [
        { header: 'Amount', from: (row) => row.amount ?? null },
        { header: 'Sub-amount', from: (row) => row.subAmount ?? null },
      ]
    ),
    statementByYearTable(
      'Balance sheet by year',
      "TallyPrime's own Balance Sheet for every book year." + YEAR_NOTE,
      data.statementsByYear,
      (entry) => entry.balanceSheet,
      [
        { header: 'Amount', from: (row) => row.amount ?? null },
        { header: 'Sub-amount', from: (row) => row.subAmount ?? null },
      ]
    ),
  ];
}
