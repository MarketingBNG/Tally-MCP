import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { TallyError } from '../tally/TallyError.js';
import {
  companySchema,
  dateRangeSchema,
  paginationSchema,
  PERIOD_NOTE,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import { paginate, resolvePagination } from '../utils/pagination.js';
import {
  assertResultSetFits,
  findByName,
  fromPage,
  noteEmptyDefaultedPeriod,
  periodWasDefaulted,
  resolvePeriod,
  runTool,
  type ToolDeps,
} from './toolResult.js';
import { buildMovements } from './ledgerMovements.js';
import { fetchLedgers } from './ledgers.js';
import { fetchVouchers } from './vouchers.js';

/**
 * Per-ledger transaction statement.
 *
 * ## Why this is derived rather than fetched
 *
 * TallyPrime has its own per-ledger report, but its exact export ID is not
 * documented in a way worth trusting. Guessing wrong is not a failed query
 * here: an unresolvable report or collection name makes TallyPrime raise a
 * modal dialog, stop serving HTTP, and exit when the dialog is dismissed —
 * taking the user's open books with it. That is documented in
 * docs/known-limitations.md and it is the reason this tool is built on
 * `Voucher Register`, which is verified working, and filters entries for the
 * requested ledger locally.
 *
 * The trade-off is honest and stated in the tool description: the movement
 * lines are Tally's own data, while the running balance is computed here. If
 * Tally's report ID is later confirmed against a real install, this can be
 * swapped for the native path without changing the output shape.
 */

const DESCRIPTION = [
  'Statement of movements on a single ledger over a period: every entry that touched the ' +
    'account, with a running balance.',
  '',
  'WHEN TO USE: to see the activity behind a ledger balance — what a party was invoiced and ' +
    'paid, or what went through an expense account and when.',
  '',
  'RETURNS: the ledger opening balance, then one line per entry (date, voucher number and type, ' +
    'the counterparty ledgers on the other side of the entry, amount, side) with a running ' +
    'balance after each, plus the computed closing balance for the period.',
  '',
  'HOW IT IS BUILT — worth knowing before relying on the running balance: the entries come ' +
    'straight from TallyPrime voucher register for the period, filtered to this ledger. The ' +
    'RUNNING BALANCE and the period closing balance are computed by this server from the ' +
    'opening balance plus those entries. They are not figures TallyPrime reported. Tally own ' +
    'closing balance for the ledger is returned separately as ' +
    '"tallyReportedClosingBalance" for comparison — note it is as at Tally current period end, ' +
    'not the end of the range requested here, so the two agree only when the range covers the ' +
    'whole period.',
  '',
  PERIOD_NOTE,
  '',
  'PAGINATION: client-side over a full fetch of the period. The running balance is computed ' +
    'across the WHOLE period before slicing, so page 2 continues correctly from page 1.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

const NARROW_HINT =
  'Narrow the date range. Tally returns the whole period in one response, so a shorter period ' +
  'is the only way to make this query smaller.';

export function registerLedgerTransactionTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_get_ledger_transactions',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        name: z.string().min(1).describe('Exact ledger name as it appears in TallyPrime.'),
        company: companySchema,
        ...dateRangeSchema,
        ...paginationSchema,
      }),
    },
    async (args) =>
      runTool('tally_get_ledger_transactions', deps, async () => {
        const pagination = resolvePagination(args.page, args.pageSize);
        const period = resolvePeriod(args.fromDate, args.toDate);

        // The ledger master, for the opening balance and to confirm the ledger
        // exists at all — a typo should not look like a ledger with no activity.
        const { ledgers, warnings: ledgerWarnings } = await fetchLedgers(deps, args.company);
        const ledger = findByName(ledgers, args.name, (candidate) => candidate.name);

        if (ledger === undefined) {
          throw new TallyError(
            'TALLY_COMPANY_NOT_FOUND',
            `No ledger named "${args.name}" exists in the loaded company.`,
            {
              suggestion:
                'Check the spelling, or use tally_get_ledgers with a `query` fragment to find the ledger by name.',
            }
          );
        }

        const { vouchers, warnings: voucherWarnings } = await fetchVouchers(
          deps,
          args.company,
          period
        );

        const warnings = [
          ...(await noteEmptyDefaultedPeriod(
            deps,
            period,
            periodWasDefaulted(args.fromDate, args.toDate),
            vouchers.length
          )),
          ...ledgerWarnings,
          ...voucherWarnings,
        ];

        const movements = buildMovements(vouchers, ledger.name, ledger.openingBalance, warnings);
        assertResultSetFits(movements.length, deps.config, NARROW_HINT);

        const last = movements[movements.length - 1];

        return fromPage(paginate(movements, pagination, warnings), {
          ledger: {
            name: ledger.name,
            parent: ledger.parent,
            source: ledger.source,
          },
          period,
          openingBalance: ledger.openingBalance,
          /**
           * Computed here from opening balance plus the period movements.
           *
           * NOT `last?.runningBalance ?? ledger.openingBalance`. `??` fires on
           * null as well as undefined, and a running balance is legitimately
           * null: `buildMovements` abandons the running total for good the
           * moment any entry carries an unreadable amount. So the fallback
           * reported the OPENING balance as the closing one — a real figure in
           * the wrong field, indistinguishable from a ledger that genuinely did
           * not move. The two cases are different and only one may fall back:
           *   - no movements at all  -> closing IS opening
           *   - total not computable -> null, and the warning says why
           */
          computedClosingBalance: last === undefined ? ledger.openingBalance : last.runningBalance,
          /**
           * Tally's own figure, as at its current period end rather than the
           * requested range. Provided for comparison, not as the same thing.
           */
          tallyReportedClosingBalance: ledger.closingBalance,
        });
      })
  );
}
