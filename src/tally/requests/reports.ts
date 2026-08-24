
/**
 * Tally request construction.
 *
 * Tally is a single-endpoint POST API: everything goes to the same URL and
 * the payload decides what you get. Request *shape* is documented (unlike
 * response shape), so this module can be written and tested without
 * ground-truth samples.
 *
 * READ-ONLY GUARANTEE: `TALLYREQUEST` is hard-coded to `Export` in every
 * builder here, and no builder emits an Import/Alter/Delete envelope. This is
 * the only place Tally request bodies are constructed — tool code never
 * assembles payloads directly — so this file is the single place to audit
 * that claim. There is a test asserting no write verb appears anywhere.
 */
import { buildReportRequest, type TallyRequestOptions } from './envelope.js';

/**
 * The statement and stock reports.
 *
 * Split out of requests.ts at 736 lines. Every one of these is a report ID
 * verified against a live install — see docs and the note on report IDs being
 * the safe class, unlike collection types.
 */

/** Trial balance for a date range. */
export function buildTrialBalanceRequest(options: TallyRequestOptions): string {
  return buildReportRequest('Trial Balance', options);
}

/** Balance sheet as at the end of the range. */
export function buildBalanceSheetRequest(options: TallyRequestOptions): string {
  return buildReportRequest('Balance Sheet', options);
}

/** Profit and loss for the range. */
export function buildProfitLossRequest(options: TallyRequestOptions): string {
  return buildReportRequest('Profit and Loss', options);
}

/**
 * Monthly cash movement — Tally's own "Cash Flow" report.
 *
 * Verified against a live install (2026-08-12): returns alternating
 * DSPPERIOD/DSPACCINFO siblings, one pair per month, each carrying debit,
 * credit and net columns where net = debit + credit. This is monthly
 * movement, NOT a classified cash flow statement — Tally supplies no
 * operating/investing/financing split.
 */
export function buildCashFlowRequest(options: TallyRequestOptions): string {
  return buildReportRequest('Cash Flow', options);
}

/**
 * Monthly funds movement — Tally's own "Funds Flow" report.
 *
 * Same wire shape as the cash flow report but different column semantics,
 * verified live: each month's debit equals the previous month's credit, and
 * net = credit − debit — Tally is reporting opening funds, closing funds and
 * the change per month.
 */
export function buildFundsFlowRequest(options: TallyRequestOptions): string {
  return buildReportRequest('Funds Flow', options);
}

/**
 * Closing stock per item — Tally's own "Stock Summary" report.
 *
 * Report ID verified 2026-08-10 (accepted, not rejected) but it returned an
 * empty envelope on every company probed until 2026-08-14, when a company that
 * maintains inventory finally populated it. That is why this arrived late: the
 * ID was known good long before its response shape could be read.
 *
 * Shape: alternating DSPACCNAME/DSPSTKINFO siblings, one pair per stock item,
 * carrying closing quantity, rate and value. See `normalizeClosingStock`.
 */
export function buildStockSummaryRequest(options: TallyRequestOptions): string {
  return buildReportRequest('Stock Summary', options);
}

/**
 * Closing stock per location — Tally's own "Godown Summary" report.
 *
 * Identical wire shape to Stock Summary, with godown names in place of item
 * names; verified live 2026-08-14 against a company with one godown ("Main
 * Location"). This is the only path in the server to location-wise stock.
 */
export function buildGodownSummaryRequest(options: TallyRequestOptions): string {
  return buildReportRequest('Godown Summary', options);
}
