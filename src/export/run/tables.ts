import {
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { type CompanyData } from '../collect.js';
import { contentsTable, manifestTable } from '../manifest.js';
import {
  balanceSheetTable,
  closingStockTable,
  currenciesTable,
  godownsTable,
  groupsTable,
  ledgerBalancesTable,
  ledgersTable,
  genericReportTable,
  monthlyFlowTable,
  nestedStructureTables,
  usedMastersTable,
  notInThisWorkbookTable,
  payablesTable,
  profitLossTable,
  receivablesTable,
  simpleMasterTables,
  statementsByYearTables,
  stockItemsTable,
  tallyDefaultsTable,
  trialBalanceTable,
  voucherEntriesTable,
  vouchersTable,
  voucherTypesTable,
  type Table,
} from '../tables.js';
import { csvFileName, csvIndex, toCsv } from '../csv.js';

/**
 * One export run, end to end.
 *
 * ## What this promises, and what it explicitly does not
 *
 * It promises that a run either replaces the workbook with a complete one or
 * leaves the previous one exactly as it was. Never a half-written file: the
 * workbook is written under a temporary name in the SAME folder and renamed
 * over the target, which is atomic on NTFS, so Google Drive never uploads a
 * partial workbook.
 *
 * **It cannot confirm Google Drive uploaded anything.** That is Drive Desktop's
 * business. The run log and the status filename say the file was WRITTEN, never
 * that it synced. If Drive is signed out or paused, the local file is correct
 * and the cloud copy is stale, and only Drive's own icon will say so.
 */

/**
 * The tab order the workbook is built in, and the CSV mirror of it.
 *
 * Split out of run.ts at 736 lines. Contents and Manifest come first
 * deliberately: a reader opening the workbook should land on what it contains
 * and how it was produced before any figure.
 */

/** The tab order the workbook is built in. Contents and Manifest come first. */
export function buildTables(
  data: CompanyData,
  runReason: string,
  scope: 'all-years' | 'current-year'
): Table[] {
  const godowns = godownsTable(data);
  const cashFlow = monthlyFlowTable(
    'Cash flow',
    "TallyPrime's own monthly Cash Flow. One row per month; the Net column is Tally's own " +
      'figure, not one computed here.',
    data.cashFlow
  );
  const fundsFlow = monthlyFlowTable(
    'Funds flow',
    "TallyPrime's own monthly Funds Flow. Debit and credit are the month's opening and closing " +
      "funds on this report, and Net is Tally's own figure — the arithmetic differs from cash " +
      'flow, so do not assume the columns mean the same thing.',
    data.fundsFlow
  );

  const body: Table[] = [
    // The books
    trialBalanceTable(data),
    ledgerBalancesTable(data),
    vouchersTable(data),
    voucherEntriesTable(data),
    receivablesTable(data),
    payablesTable(data),
    profitLossTable(data),
    balanceSheetTable(data),
    ...(cashFlow === null ? [] : [cashFlow]),
    ...(fundsFlow === null ? [] : [fundsFlow]),

    // The same three statements across every book year the company holds.
    ...statementsByYearTables(data),

    // The detail inside vouchers — DISCOVERED, not listed. Whatever structures
    // this company records get a tab, at every level they nest to.
    ...nestedStructureTables(data),
    usedMastersTable(data),

    // The masters
    ledgersTable(data),
    groupsTable(data),
    voucherTypesTable(data),
    stockItemsTable(data),
    closingStockTable(data),
    currenciesTable(data),
    ...(godowns === null ? [] : [godowns]),

    // The real master lists, reachable since the collection types were re-probed.
    ...simpleMasterTables(data),

    // TallyPrime's own register and exception views
    ...data.reports.map((entry) => genericReportTable(entry)),

    // The rest
    tallyDefaultsTable(data),
    notInThisWorkbookTable(),
  ];

  // Built from the body, so the row counts on both are measured from what was
  // actually assembled rather than from what was intended.
  const manifest = manifestTable(data, body, runReason, scope);
  const contents = contentsTable([manifest, ...body]);

  return [contents, manifest, ...body];
}

/**
 * Write one CSV per tab, plus the index a reader fetches first.
 *
 * Each file goes to a temp name and is renamed into place, so Google Drive
 * never uploads a half-written table — the same rule the workbook follows, for
 * the same reason.
 *
 * Files from a PREVIOUS run whose tab no longer exists are removed. A company
 * that stops using GST should not leave a GST table behind for somebody to read
 * as current; the tab would be gone from the workbook and only the stale CSV
 * would still claim it.
 */
export function writeCsvTables(folder: string, tables: readonly Table[]): void {
  mkdirSync(folder, { recursive: true });

  const written = new Set<string>();

  const put = (name: string, body: string): void => {
    const target = join(folder, name);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, body, 'utf8');
    rmSync(target, { force: true });
    renameSync(temporary, target);
    written.add(name.toLowerCase());
  };

  put('INDEX.csv', csvIndex(tables));
  for (const table of tables) put(csvFileName(table.title), toCsv(table));

  // Stale tables from an earlier run.
  for (const entry of readdirSync(folder)) {
    if (!entry.toLowerCase().endsWith('.csv')) continue;
    if (written.has(entry.toLowerCase())) continue;
    rmSync(join(folder, entry), { force: true });
  }
}
