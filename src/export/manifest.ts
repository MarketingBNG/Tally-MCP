import { Decimal } from 'decimal.js';
import { SERVER_VERSION } from '../version.js';
import type { CompanyData } from './collect.js';
import type { CellValue, Table } from './tables.js';

/**
 * The Manifest, and why it is the most important tab in the file.
 *
 * The workbook is the interface now. Claude answers from these rows rather than
 * from tools that attach their own warnings, currency labelling, period
 * resolution and population rules — so anything the tools would have said has
 * to be IN the file. Without this the workbook is a pile of numbers with no
 * context, and confident wrong answers are the predictable result.
 *
 * Concretely, this tab is what stops:
 *
 * - dollars being labelled as rupees (the connector has been wrong here before,
 *   and the fix was to record HOW the currency was derived, not just what it is);
 * - a question about "last year" being answered from a file that holds one year;
 * - a figure being quoted as "now" when it is as at the last successful run;
 * - a truncated export looking complete, which the per-tab row counts expose;
 * - sales ORDERS being totalled into expenses, which the exclusion-flag note
 *   is there to prevent.
 */

/** One name/value line on the Manifest. */
type Entry = [string, CellValue];

/**
 * Amounts Excel cannot hold exactly.
 *
 * Excel stores numbers as float64; our amounts are `decimal.js`. On ordinary
 * two-decimal money this list is empty. When it is not, the workbook SAYS SO
 * rather than quietly disagreeing with the books — which is the failure mode
 * that would otherwise be invisible until somebody reconciled by hand.
 */
export function roundTripFailures(tables: readonly Table[]): string[] {
  const failures: string[] = [];

  for (const table of tables) {
    for (const [rowIndex, row] of table.rows.entries()) {
      for (const [columnIndex, cell] of row.entries()) {
        if (!(cell instanceof Decimal)) continue;
        const asNumber = cell.toNumber();
        // Compared as decimal strings, not as numbers: comparing the floats
        // would be asking the very representation under test to judge itself.
        if (new Decimal(asNumber).equals(cell)) continue;
        failures.push(
          `${table.title} row ${String(rowIndex + 2)}, column "${
            table.columns[columnIndex]?.header ?? String(columnIndex + 1)
          }": the books hold ${cell.toString()} and a spreadsheet can only hold ${String(asNumber)}.`
        );
      }
    }
  }

  return failures;
}

/**
 * Build the Manifest.
 *
 * `tables` is everything else in the workbook, so the row counts are measured
 * from what was actually written rather than from what was intended.
 */
export function manifestTable(
  data: CompanyData,
  tables: readonly Table[],
  runReason: string,
  /**
   * Which of the two files this Manifest belongs to.
   *
   * Both files exist in the same folder and look alike. Saying which one a
   * reader has open — and that the other exists — is the difference between
   * "this company had no transactions in 2023" and "you are reading the file
   * that does not go back that far".
   */
  scope: 'all-years' | 'current-year' = 'all-years'
): Table {
  const entries: Entry[] = [
    [
      'WHICH FILE THIS IS',
      scope === 'current-year'
        ? 'THE CURRENT BOOK YEAR ONLY. A smaller, faster companion file. If a question reaches ' +
          'further back than the period below, this file CANNOT answer it — open the workbook ' +
          'of the same name WITHOUT "- current year only", which holds every year TallyPrime ' +
          'has. Do not report a zero from this file for a date it does not cover.'
        : 'THE FULL HISTORY — every book year TallyPrime holds for this company. There is a ' +
          'smaller companion beside it named "... - current year only.xlsx" carrying just the ' +
          'current year; prefer that one when the question is about this year, because this ' +
          'file is several times larger to read.',
    ],
    ['Company (TallyPrime\'s own spelling — quote THIS, not the folder name)', data.company.name],
    ['Country as Tally reports it', data.company.country],
    ['Currency', data.currency.label],
    ['How the currency was established', describeCurrencySource(data)],
    [
      'Safe to compare with another company\'s figures',
      data.currency.comparable
        ? 'Yes — this label was established, not inferred.'
        : 'NO. This label was inferred or could not be established, so it may match another ' +
          'company\'s label while the books are in a different currency. Never subtract across ' +
          'companies on the strength of it.',
    ],
    ['Period the voucher tabs cover', `${data.period.fromDate} to ${data.period.toDate}`],
    [
      'Period the STATEMENT tabs cover',
      `${data.statementPeriod.fromDate} to ${data.statementPeriod.toDate}. Different from the ` +
        'voucher period above, and not an oversight: TallyPrime honours a statement end date ' +
        'ONLY when it falls on the 31st of a month, so the statements are its own current book ' +
        'year. Do not tie a statement to the whole voucher history.',
    ],
    ['Company books start', data.company.startingFrom],
    ['Company books hold data to', data.company.endingAt],
    [
      'Dates actually seen on vouchers',
      describeVoucherSpan(data),
    ],
    ['As at (last successful read from TallyPrime)', data.asOf],
    [
      'What "as at" means here',
      'Every figure in this workbook was read from TallyPrime at that moment. It is NOT "now". ' +
        'Qualify answers as at that timestamp. If the books have changed since, this file does ' +
        'not know.',
    ],
    ['Why this run happened', runReason],
    ['Written by', `tally-mcp ${SERVER_VERSION}`],
  ];

  const rows: CellValue[][] = entries.map(([label, value]) => ['Company', label, value]);

  // --- Column notes -------------------------------------------------------
  for (const [label, value] of COLUMN_NOTES) rows.push(['How to read the figures', label, value]);

  // --- Exclusion flags ----------------------------------------------------
  for (const [label, value] of EXCLUSION_NOTES) rows.push(['Which vouchers to exclude', label, value]);

  // --- Row counts ---------------------------------------------------------
  for (const table of tables) {
    rows.push(['Row count', table.title, table.rows.length]);
  }

  // --- Round-trip check ---------------------------------------------------
  const failures = roundTripFailures(tables);
  rows.push([
    'Number precision',
    'Amounts a spreadsheet cannot hold exactly',
    failures.length === 0
      ? 'None. Every amount in this workbook survives the trip into a spreadsheet unchanged.'
      : `${String(failures.length)} amount(s). They are listed below, and the spreadsheet value ` +
        'differs from the books. Do not quote those cells without checking the books.',
  ]);
  for (const failure of failures) {
    rows.push(['Number precision', 'Cannot be held exactly', failure]);
  }

  // --- Warnings, verbatim -------------------------------------------------
  if (data.warnings.length === 0) {
    rows.push([
      'Warning from TallyPrime',
      'None',
      'No fetch in this run produced a warning.',
    ]);
  }
  for (const [index, warning] of data.warnings.entries()) {
    rows.push(['Warning from TallyPrime', `Warning ${String(index + 1)}`, warning]);
  }

  // --- The file itself ----------------------------------------------------
  for (const [label, value] of FILE_NOTES) rows.push(['About this file', label, value]);

  return {
    title: 'Manifest',
    description:
      'What makes the rest of this workbook safe to read: the company, the currency and how it ' +
      'was established, the period, the as-at stamp, the row counts, and every warning ' +
      'TallyPrime produced. Read this tab first.',
    columns: [
      { header: 'Section', kind: 'text' },
      { header: 'Item', kind: 'text' },
      { header: 'Detail', kind: 'text' },
    ],
    rows,
  };
}

/**
 * The span the vouchers in this file ACTUALLY cover.
 *
 * Measured from the rows rather than restated from the request, because those
 * are different claims. A book year that timed out is excluded from the data
 * with a warning; the requested period would still say it was asked for, and a
 * reader would conclude a silent year was a year with no trading.
 */
function describeVoucherSpan(data: CompanyData): string {
  const dates = data.vouchers.map((voucher) => voucher.date).filter((date): date is string => date !== null);

  if (dates.length === 0) {
    return (
      'NO VOUCHERS ARE PRESENT. That is not the same as a company with no transactions — check ' +
      'the warnings below for a book year that could not be read before concluding anything ' +
      'about trading.'
    );
  }

  const earliest = dates.reduce((low, date) => (date < low ? date : low));
  const latest = dates.reduce((high, date) => (date > high ? date : high));
  const years = new Set(dates.map((date) => date.slice(0, 4)));

  return (
    `${earliest} to ${latest}, spanning ${String(years.size)} calendar year(s) and ` +
    `${String(dates.length)} voucher(s). A question about a date outside that span cannot be ` +
    'answered from this file — say so rather than reporting a zero.'
  );
}

function describeCurrencySource(data: CompanyData): string {
  switch (data.currency.source) {
    case 'tally':
      return 'TallyPrime reported this symbol on the company itself. This is the strongest form.';
    case 'configuration':
      return 'TALLY_CURRENCY_LABEL, supplied by whoever set this up — NOT reported by ' +
        'TallyPrime. TallyPrime could not transport its own symbol for this company.';
    case 'tally-formal-name':
      return "TallyPrime's spelled-out name for the company's own currency master. Its SYMBOL " +
        'would not transport (it arrives as "?"), but the name did, so this is a fact from the ' +
        'company\'s currency master rather than a guess.';
    case 'derived-from-country':
      return 'INFERRED from the company\'s country, because nothing above answered. An ' +
        'inference, not a fact. Never comparable with another company.';
    default:
      return 'COULD NOT BE ESTABLISHED. Figures in this workbook carry no reliable currency ' +
        'label — say so rather than naming a currency.';
  }
}

const COLUMN_NOTES: Entry[] = [
  [
    'Sign convention',
    "Tally's own, preserved and never corrected. Debit balances arrive NEGATIVE. On the trial " +
      'balance the debit column is negative; on the balance sheet, assets are negative and ' +
      'liabilities positive; on profit and loss, expenses are negative and income positive. ' +
      'Report the magnitude and say which side it is — do not describe an asset as having a ' +
      'negative value.',
  ],
  [
    'Where the figures come from',
    "These are TallyPrime's own figures, written through unchanged. Nothing in this workbook " +
      'was recomputed, adjusted, converted or rounded by the exporter.',
  ],
  [
    'Empty cells',
    'An empty cell is TallyPrime reporting NOTHING for that field. It is not a zero, and it ' +
      'must not be totalled as one.',
  ],
  [
    'Empty tabs',
    'A tab that is present and empty means this company does not use that feature. An empty ' +
      'tab is an answer, not a gap — unless a warning above says the read FAILED, which is the ' +
      'one case where absent means unknown.',
  ],
  [
    'Trial balance versus the ledger masters',
    "TallyPrime's trial balance carries stock at its OPENING value while the ledger masters and " +
      'the balance sheet carry it at closing. The two disagree by the period movement. Nothing ' +
      'here reconciles them; if a warning above names the amount, quote it.',
  ],
  [
    'Quantities',
    'Stock quantities are strings WITH their unit, exactly as Tally formats them, because a ' +
      'bare stock number is meaningless. Never multiply quantity by rate — the rate is rounded ' +
      'to the displayed decimals and the product disagrees with the value Tally holds.',
  ],
];

const EXCLUSION_NOTES: Entry[] = [
  [
    'Order voucher',
    'A sales or purchase ORDER: a commitment with NO ledger entries. EXCLUDE from anything ' +
      'about money — revenue, expenses, totals. It contributes nothing to a total while ' +
      'inflating a voucher COUNT, so exclude it from counts too unless the question is ' +
      'explicitly about orders.',
  ],
  [
    'Cancelled',
    'The voucher was cancelled in Tally. EXCLUDE from every financial question. Include only ' +
      'when the question is about cancellations themselves.',
  ],
  [
    'Optional',
    'A voucher Tally does not post to the books. EXCLUDE from every financial question — ' +
      'including it double-counts a transaction that has not happened.',
  ],
  [
    'Inventory voucher',
    'A stock-only voucher such as a delivery or receipt note: it moves inventory without ' +
      'touching accounts. Whether it belongs in a STOCK figure is a judgement — a receipt note ' +
      'and the purchase invoice that follows it describe the same goods, so counting both ' +
      'double-counts. Exclude from money questions.',
  ],
  [
    'The short version',
    'For any question about money: exclude rows where Cancelled, Optional, Order voucher or ' +
      'Inventory voucher is "Yes". State that you did.',
  ],
];

const FILE_NOTES: Entry[] = [
  [
    'This file is generated',
    'It is REPLACED on every run. Anything you type into it is lost at the next run. A dated ' +
      'copy of each day lands in the Archive folder beside it, so an earlier position is always ' +
      'retrievable — but annotations are not. Keep notes in a separate file.',
  ],
  [
    'Do not use File → Save as Google Sheets',
    'That creates a SEPARATE native copy the exporter will never touch again. It silently ' +
      'becomes a frozen snapshot while looking like the live file, and anyone reading it — ' +
      'including Claude — would answer from stale books without knowing. Open the .xlsx ' +
      'directly; Sheets reads it with tabs intact and nothing needs importing.',
  ],
  [
    'Whether Google Drive has this copy',
    'UNKNOWN to this file. The exporter can confirm it wrote the file to disk; it cannot ' +
      'confirm Google Drive uploaded it. If Drive is signed out or paused, the local file is ' +
      'correct and the cloud copy is stale, and only Drive\'s own icon will say so. The as-at ' +
      'stamp above is the reader\'s defence: if it is old, the file is old.',
  ],
  [
    'If a figure has to go into an audit file',
    'Check it against the live TallyPrime connector before it does. The figures here are ' +
      "Tally's own, but the tested audit procedures — tie-out, ageing, materiality, sampling, " +
      'late-entry — did not produce these rows, and arithmetic over a spreadsheet is not the ' +
      'same evidence.',
  ],
];

/**
 * The Contents tab: the way in to a twenty-tab workbook.
 *
 * Anyone opening this needs one, and so does Claude — it is the difference
 * between reading the right tab and guessing at a tab name.
 */
export function contentsTable(tables: readonly Table[]): Table {
  return {
    title: 'Contents',
    description: 'What each tab holds, and how many rows it has.',
    columns: [
      { header: 'Tab', kind: 'text' },
      { header: 'Rows', kind: 'count' },
      { header: 'What it holds', kind: 'text' },
    ],
    rows: tables.map((table) => [
      table.title,
      table.rows.length,
      table.rows.length === 0 && table.emptyMeans !== undefined
        ? `${table.description}  —  EMPTY: ${table.emptyMeans}`
        : table.description,
    ]),
  };
}
