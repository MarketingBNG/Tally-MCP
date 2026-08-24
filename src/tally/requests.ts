/**
 * Every request body this server sends TallyPrime, and nothing else.
 *
 * This is now a re-export barrel. The builders grew to 736 lines, split into
 * ./requests/ as pure moves:
 *
 *   - envelope.ts  the shared envelope, the Export-only verb, and the two
 *                  generic builders every other module goes through
 *   - masters.ts   the master collections
 *   - vouchers.ts  the voucher collection, register, and AlterId fingerprints
 *   - reports.ts   the statement and stock reports
 *
 * The reason they are all in one directory rather than beside their callers is
 * the Export-only guarantee: every body this server can emit is built here, so
 * a test can assert that no write verb appears in any of them.
 */

export {
  buildCollectionRequest,
  buildConnectionProbeRequest,
  buildReportRequest,
  escapeXml,
  EXPORT_ONLY,
  FORBIDDEN_WRITE_VERBS,
  UNSCOPED,
  type CompanyScope,
  type TallyRequestOptions,
  type TallyWireFormat,
} from './requests/envelope.js';
export {
  buildCompanyListRequest,
  buildCurrencyListRequest,
  buildGroupListRequest,
  buildLedgerListRequest,
  buildSimpleMasterRequest,
  buildStockItemListRequest,
  buildVoucherTypeListRequest,
  SIMPLE_MASTER_TYPES,
  type SimpleMasterType,
} from './requests/masters.js';
export {
  buildLedgerAlterIdRequest,
  buildVoucherAlterIdRequest,
  buildVoucherCollectionRequest,
  buildVoucherRegisterRequest,
} from './requests/vouchers.js';
export {
  buildBalanceSheetRequest,
  buildCashFlowRequest,
  buildFundsFlowRequest,
  buildGodownSummaryRequest,
  buildProfitLossRequest,
  buildStockSummaryRequest,
  buildTrialBalanceRequest,
} from './requests/reports.js';
