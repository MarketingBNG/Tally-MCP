/**
 * `tally_get_vouchers`: the transaction register.
 *
 * This is now a re-export barrel. The tool grew to 989 lines, split into
 * ./vouchers/ as pure moves:
 *
 *   - fetch.ts     fetching across book years, dedupe, the parsed-voucher cache,
 *                  and the reach-shortfall disclosure
 *   - register.ts  the tool registration, the sales/purchases families, and the
 *                  page folding
 *
 * The fetch path is the one every other voucher-reading tool goes through — bank
 * reconciliation, outstanding, GST, TDS, inventory movements — so it keeps its
 * own module and its cache.
 */

export {
  bookYearsSpanning,
  describeVoucherReachShortfall,
  fetchVouchers,
  filterByPeriod,
} from './vouchers/fetch.js';
export { registerVoucherTools } from './vouchers/register.js';
