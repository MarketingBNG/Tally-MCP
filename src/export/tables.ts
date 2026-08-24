/**
 * Turning normalised records into sheets — and nothing else.
 *
 * This is now a re-export barrel. The builders grew to 1,309 lines across five
 * banner-delimited groups, split into ./tables/ as pure moves:
 *
 *   - shared.ts   the Table/Column vocabulary and the cell helpers
 *   - core.ts     trial balance, ledgers, vouchers, entries, receivables,
 *                 payables, P&L and balance sheet
 *   - nested.ts   the structures discovered from the payload rather than
 *                 declared, and the masters actually used
 *   - masters.ts  one table per master collection, plus the by-year series
 *   - extras.ts   monthly flow, generic report, simple masters, and the two
 *                 tables that disclose what the workbook itself does and does
 *                 not contain
 *
 * Every importer keeps importing from here, so the split cost no call site a
 * change.
 */

export {
  sheetName,
  type CellValue,
  type Column,
  type ColumnKind,
  type Table,
} from './tables/shared.js';
export {
  balanceSheetTable,
  ledgerBalancesTable,
  payablesTable,
  profitLossTable,
  receivablesTable,
  trialBalanceTable,
  voucherEntriesTable,
  vouchersTable,
} from './tables/core.js';
export { nestedStructureTables, usedMastersTable } from './tables/nested.js';
export {
  closingStockTable,
  currenciesTable,
  godownsTable,
  groupsTable,
  ledgersTable,
  statementsByYearTables,
  stockItemsTable,
  voucherTypesTable,
} from './tables/masters.js';
export {
  genericReportTable,
  monthlyFlowTable,
  notInThisWorkbookTable,
  simpleMasterTables,
  tallyDefaultsTable,
} from './tables/extras.js';
