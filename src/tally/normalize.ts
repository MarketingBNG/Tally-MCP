/**
 * Domain normalisation: Tally's XML shapes to the records tools return.
 *
 * This is now a re-export barrel. The normalisers live in ./normalize/, one
 * module per entity family, split out when this file reached 1,461 lines across
 * thirteen sections that shared only a handful of helpers. Every importer keeps
 * importing from here, so the split cost no call site a change.
 *
 * The two rules every normaliser follows are stated in each module: sign is
 * preserved rather than corrected, and an unreadable value becomes null plus a
 * warning rather than a zero.
 */

export { type Normalized, type SourceRef, unreadablePayloadWarning } from './normalize/shared.js';
export {
  normalizeCompanies,
  normalizeCurrencies,
  type Company,
  type Currency,
} from './normalize/companies.js';
export {
  normalizeGroups,
  normalizeLedgers,
  normalizeSimpleMasters,
  normalizeStockItems,
  normalizeVoucherTypes,
  type Group,
  type Ledger,
  type SimpleMaster,
  type StockItem,
  type VoucherNumberSeries,
  type VoucherType,
} from './normalize/masters.js';
export {
  normalizeBalanceSheet,
  normalizeClosingStock,
  normalizeGenericReport,
  normalizeMonthlyFlow,
  normalizeProfitLoss,
  normalizeTrialBalance,
  type ClosingStockRow,
  type GenericReportRow,
  type MonthlyFlowRow,
  type StatementRow,
  type TrialBalanceRow,
} from './normalize/reports.js';
export {
  normalizeVouchers,
  type EntrySide,
  type LedgerEntry,
  type Voucher,
} from './normalize/vouchers.js';
