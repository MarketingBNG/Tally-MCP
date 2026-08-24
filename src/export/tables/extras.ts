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
  type CellValue,
  type Column,
  type Table,
  byName,
  varyingFieldKeys,
} from './shared.js';

/**
 * The remaining tables: monthly flow, the generic report, the simple masters,
 * and the two tables that describe the workbook itself.
 *
 * Split out of tables.ts at 1,309 lines. `tallyDefaultsTable` and
 * `notInThisWorkbookTable` are the workbook's own disclosure — what Tally
 * defaulted, and what is deliberately absent — which is why they sit apart from
 * the data tables.
 */

/**
 * A monthly flow report — cash flow or funds flow.
 *
 * The `Net` column is TALLY'S OWN, passed through rather than recomputed, and
 * it is not the same arithmetic on both reports: observed live it is
 * debit + credit on cash flow, and credit − debit on funds flow, where the two
 * columns are the month's opening and closing funds. Recomputing it here would
 * silently be wrong on one of them.
 */
export function monthlyFlowTable(
  title: string,
  description: string,
  statement: CompanyData['cashFlow']
): Table | null {
  if (statement === null) return null;

  return {
    title,
    description,
    columns: [
      { header: 'Month', kind: 'text' },
      { header: 'Debit', kind: 'amount' },
      { header: 'Credit', kind: 'amount' },
      { header: "Net (Tally's own figure)", kind: 'amount' },
    ],
    // Tally's own row order — the months in sequence. Sorting alphabetically
    // would file April before January and make the report unreadable.
    rows: (
      statement.rows as {
        period: string;
        debit: Money | null;
        credit: Money | null;
        net: Money | null;
      }[]
    ).map((row) => [row.period, amount(row.debit), amount(row.credit), amount(row.net)]),
    emptyMeans:
      'TallyPrime returned no rows for this report on this company. The report is valid, so ' +
      'this is an absence of data rather than a failure.',
  };
}

/**
 * One of TallyPrime's register or exception views, as it produced it.
 *
 * ## The column names are Tally's tag names, deliberately
 *
 * Everywhere else in this workbook the headings are rewritten into English.
 * Not here. These reports' column MEANINGS have never been verified — several
 * return nothing on every company measured so far — so renaming `DSPCLDRAMTA`
 * to "Debit" would be asserting something nobody has checked. The tag name is
 * honest about what it is, and the Contents tab says so.
 */
export function genericReportTable(entry: CompanyData['reports'][number]): Table {
  const rows = entry.report.rows as { name: string; amounts: Record<string, string> }[];

  const keys = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row.amounts)) keys.add(key);
  const columns = [...keys].sort();

  return {
    title: entry.title,
    description:
      `${entry.report.what} From TallyPrime's own "${entry.report.reportId}" report` +
      (entry.report.verified === 'empty'
        ? ' — ROW SHAPE UNVERIFIED: Tally accepts this report but returned nothing on every ' +
          'company tested, so its column meanings have never been observed. Check any figure ' +
          'here against the report on screen in TallyPrime before relying on it.'
        : '.') +
      " Column names are TallyPrime's own tag names, not renamed columns: say which tag a " +
      'figure came from rather than calling it a debit or a credit.',
    columns: [
      { header: 'Name', kind: 'text' },
      // Amounts as TEXT, not numbers. Which of these columns is money and which
      // is a quantity, a rate or a count is exactly what is unverified — writing
      // them as numbers would invite a total nobody can justify.
      ...columns.map((key): Column => ({ header: key, kind: 'text' })),
    ],
    rows: rows.map((row) => [row.name, ...columns.map((key) => row.amounts[key] ?? null)]),
    emptyMeans:
      'TallyPrime returned no rows. For a register that means no transactions of that kind in ' +
      'the period; for an exception report it means nothing was flagged; for a feature the ' +
      'company does not use — bill-wise accounting, inventory, cost categories — it means the ' +
      'feature is unused. It does NOT mean the figure is zero.',
  };
}

/**
 * The real master lists — cost centres, units, godowns and their kin.
 *
 * These are the genuine article, unlike the "Used cost centres and godowns" tab
 * derived from voucher allocations. A cost centre that exists in TallyPrime and
 * has never been posted to appears HERE and not there, which is exactly the
 * distinction that tab has to disclaim and this one does not.
 *
 * Unreachable until 2026-08-21 — see `normalizeSimpleMasters` for what changed
 * and what is still off limits.
 */
export function simpleMasterTables(data: CompanyData): Table[] {
  return data.simpleMasters.map((entry) => {
    const keys = new Set<string>();
    for (const record of entry.records) for (const key of Object.keys(record.fields)) keys.add(key);
    const columns = [...keys].sort();

    return {
      title: entry.title,
      description:
        `TallyPrime's own ${entry.title.toLowerCase()} master list, read from the ${entry.type} ` +
        'collection. This is the DEFINED list — unlike the "Used cost centres and godowns" tab, ' +
        'which is built from voucher allocations and therefore shows only what has been posted ' +
        'to.',
      columns: [
        { header: 'Name', kind: 'text' },
        { header: 'Parent', kind: 'text' },
        ...columns.map((key): Column => ({ header: key, kind: 'text' })),
      ],
      rows: [...entry.records]
        .sort((a, b) => byName(a.name, b.name))
        .map((record) => [
          record.name,
          record.parent,
          ...columns.map((key) => record.fields[key] ?? null),
        ]),
      emptyMeans:
        `This company defines no ${entry.title.toLowerCase()}. TallyPrime served the list and it ` +
        'was empty — the feature is unused, which is NOT the same as the read having failed. A ' +
        'failed read would say so in the Manifest warnings.',
    };
  });
}

/**
 * The fields carrying the same value on every record of a collection.
 *
 * This is the tab that makes the rest readable, and it is a RELOCATION rather
 * than a filter: every value Tally sent is still in the workbook, written once
 * instead of repeated down 200 columns. Measured on a real company's year, 453
 * vouchers carried 204 populated fields of which only 33 varied — the other 171
 * were `ISDELETED: No`, `AUDITED: No`, `USEFORSERVICETAX: No` and their kind.
 *
 * `foldUniformFields` folds nothing below two records, since with one record
 * every field is trivially uniform. On such a company these values stay on the
 * record's own tab instead, which is correct and is why the note below says to
 * check both places.
 */
export function tallyDefaultsTable(data: CompanyData): Table {
  const rows: CellValue[][] = [];

  const sources: [string, readonly { fields?: Record<string, string> }[]][] = [
    ['Vouchers', data.vouchers],
    ['Ledgers', data.ledgers],
    ['Stock items', data.stockItems],
  ];

  for (const [what, records] of sources) {
    const { uniform } = varyingFieldKeys(records);
    for (const [key, value] of Object.entries(uniform).sort(([a], [b]) => a.localeCompare(b))) {
      rows.push([what, key, value, records.length]);
    }
  }

  return {
    title: 'Tally defaults',
    description:
      'Fields holding ONE value on every record of a tab, written once here instead of ' +
      'repeated on every row. They ARE present on every record in TallyPrime — look here ' +
      'before concluding a field is absent. A constant value is usually a TallyPrime default ' +
      "rather than something this company recorded, so it rarely answers a question about the " +
      "company's data.",
    columns: [
      { header: 'Tab', kind: 'text' },
      { header: 'Field', kind: 'text' },
      { header: 'Value on every record', kind: 'text' },
      { header: 'Records it applies to', kind: 'count' },
    ],
    rows,
    emptyMeans:
      'Nothing was uniform enough to relocate — every field varied, or a tab held fewer than ' +
      'two records (below which nothing is folded, since with one record every field is ' +
      'trivially uniform).',
  };
}

/**
 * What TallyPrime holds that this interface cannot read.
 *
 * Without this tab the workbook implies it is everything, and someone will read
 * a silence as a zero. Sourced from docs/coverage.md.
 */
export function notInThisWorkbookTable(): Table {
  return {
    title: 'Not in this workbook',
    description:
      'What TallyPrime holds that this interface cannot read, and why. Read this before ' +
      'concluding that something absent from the workbook does not exist in the books.',
    columns: [
      { header: 'What is missing', kind: 'text' },
      { header: 'Why', kind: 'text' },
    ],
    rows: [
      [
        "Anything dated before the company's books start",
        'The voucher tabs cover EVERY book year TallyPrime holds for this company, not just the ' +
          'current one — years before the current one are read from the Voucher Register report, ' +
          'which honours a date range where a collection does not. What is absent is only what ' +
          'the company itself does not hold: see "Company books start" on the Manifest, and ' +
          '"Dates actually seen on vouchers" for the span really present.',
      ],
      [
        'A book year TallyPrime could not serve in time',
        'A prior year is read from a report running to tens of megabytes and can time out. When ' +
          'that happens the year is EXCLUDED, and a warning saying which years were lost appears ' +
          'on the Manifest. Check those warnings before reading a quiet year as a year with no ' +
          'trading.',
      ],
      [
        'Statements for anything but the current book year',
        'TallyPrime honours a statement end date only when it falls on the 31st of a month, so ' +
          'the trial balance, profit and loss and balance sheet cover the current book year ' +
          'only. The voucher tabs reach further back; the statements do not, and tying the two ' +
          'together would compare figures covering different spans.',
      ],
      [
        'The edit log / audit trail',
        'Not served over this interface. The "Last written" stamp on Vouchers and Voucher ' +
          'entries is the LAST write, and cannot distinguish a voucher keyed in late from one ' +
          'keyed on time and altered later, nor say who wrote it.',
      ],
      [
        'Cost Centre Summary report',
        'TallyPrime accepts the report ID but has returned no rows on every company tested, so ' +
          'its row shape has never been observed. The Cost centre allocations tab carries what ' +
          'the vouchers themselves record.',
      ],
      [
        'Cost centre, cost category and godown MASTER lists',
        'Reachable only through a TallyPrime collection type this server has never observed, and ' +
          'probing an unobserved type has twice parked TallyPrime behind a modal dialog until ' +
          'somebody dismissed it. On a machine running an unattended export every minute that is ' +
          'not an acceptable risk. Cost centre ALLOCATIONS recorded on vouchers are present, on ' +
          'their own tab.',
      ],
      [
        'Budgets',
        'Both the Budget Variance and Budgets reports are rejected by TallyPrime, and the ' +
          'collection type is unknown and cannot be probed for the reason above. ' +
          'Budget-versus-actual cannot be answered from this workbook.',
      ],
      [
        'The licence edition',
        'Not exposed over this interface. Which TallyPrime edition produced these books cannot ' +
          'be read from the data.',
      ],
    ],
  };
}
