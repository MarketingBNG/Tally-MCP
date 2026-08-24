/**
 * `tally_check_tie_out`: does this set of books agree with itself?
 *
 * This is now a re-export barrel. The tool grew to 1,149 lines, split into
 * ./tieOut/ as pure moves, one module per concern:
 *
 *   - shared.ts   signed-amount handling every check shares
 *   - checks.ts   the three checks: stock, double entry, roll-forward
 *   - run.ts      running them for one company and trimming to verbosity
 *   - register.ts the tool registration and single-versus-batch dispatch
 *
 * Every importer keeps importing from here, so the split cost no call site a
 * change.
 */

export { registerTieOutTools } from './tieOut/register.js';
export {
  checkBalanceRollForward,
  checkDoubleEntry,
  checkStockTieOut,
  type BalanceException,
  type StockTieOutException,
  type VoucherImbalance,
} from './tieOut/checks.js';
