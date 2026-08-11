import { z } from 'zod';
import { Decimal } from 'decimal.js';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildLedgerListRequest, buildVoucherRegisterRequest } from '../tally/requests.js';
import { normalizeLedgers, normalizeVouchers, type Voucher } from '../tally/normalize.js';
import { TallyError } from '../tally/TallyError.js';
import { DEFAULT_CURRENCY, type Money } from '../utils/numbers.js';
import {
  companySchema,
  dateRangeSchema,
  paginationSchema,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import { paginate, resolvePagination } from '../utils/pagination.js';
import {
  assertCompanyIsLoaded,
  assertResultSetFits,
  resolvePeriod,
  runTool,
  type ToolDeps,
} from './toolResult.js';

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
  'PERIOD: if fromDate and toDate are both omitted, the Indian financial year containing today ' +
    'is used, and the period used is echoed back. Supply both dates or neither.',
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

export interface LedgerMovement {
  date: string | null;
  voucherNumber: string | null;
  voucherType: string | null;
  /** Party on the voucher, where Tally recorded one. */
  partyLedgerName: string | null;
  narration: string | null;
  /** The other ledgers on this voucher — what the entry was against. */
  contraLedgers: string[];
  amount: Money | null;
  side: 'debit' | 'credit';
  /**
   * Balance after this entry, computed by this server rather than reported by
   * Tally. Null when an amount could not be read, since continuing the
   * running total past an unreadable figure would make every later balance
   * wrong without saying so.
   */
  runningBalance: Money | null;
}

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
      runTool('tally_get_ledger_transactions', deps.logger, async () => {
        const pagination = resolvePagination(args.page, args.pageSize);
        const period = resolvePeriod(args.fromDate, args.toDate);
        await assertCompanyIsLoaded(deps, args.company);

        const companyOption = args.company === undefined ? {} : { company: args.company };

        // The ledger master, for the opening balance and to confirm the ledger
        // exists at all — a typo should not look like a ledger with no activity.
        const ledgerResponse = await deps.client.send(
          buildLedgerListRequest({ ...companyOption, format: deps.config.tallyPreferredFormat }),
          'standard'
        );
        const ledgers = normalizeLedgers(ledgerResponse.body).data;
        const ledger =
          ledgers.find((candidate) => candidate.name === args.name) ??
          ledgers.find((candidate) => candidate.name.toLowerCase() === args.name.toLowerCase());

        if (ledger === undefined) {
          throw new TallyError(
            'TALLY_COMPANY_NOT_FOUND',
            `No ledger named "${args.name}" exists in the loaded company.`,
            {
              suggestion:
                'Check the spelling, or use tally_search_ledgers to find the ledger by a fragment of its name.',
            }
          );
        }

        const voucherResponse = await deps.client.send(
          buildVoucherRegisterRequest({
            ...companyOption,
            fromDate: period.fromDate,
            toDate: period.toDate,
            format: deps.config.tallyPreferredFormat,
          }),
          'report'
        );
        const { data: vouchers, warnings: voucherWarnings } = normalizeVouchers(
          voucherResponse.body
        );

        const warnings = [
          ...ledgerResponse.repairs,
          ...voucherResponse.repairs,
          ...voucherWarnings,
        ];

        const movements = buildMovements(vouchers, ledger.name, ledger.openingBalance, warnings);
        assertResultSetFits(movements.length, deps.config, NARROW_HINT);

        const last = movements[movements.length - 1];

        return {
          ledger: {
            name: ledger.name,
            parent: ledger.parent,
            source: ledger.source,
          },
          period,
          openingBalance: ledger.openingBalance,
          /** Computed here from opening balance plus the period movements. */
          computedClosingBalance: last?.runningBalance ?? ledger.openingBalance,
          /**
           * Tally's own figure, as at its current period end rather than the
           * requested range. Provided for comparison, not as the same thing.
           */
          tallyReportedClosingBalance: ledger.closingBalance,
          ...paginate(movements, pagination, warnings),
        };
      })
  );
}

/**
 * Turn vouchers into movements on one ledger, carrying a running balance.
 *
 * Sorted by date before accumulating: the register is returned in Tally's own
 * order, and a running balance that follows an unsorted sequence is arithmetic
 * nonsense even though every individual figure is right.
 */
function buildMovements(
  vouchers: readonly Voucher[],
  ledgerName: string,
  openingBalance: Money | null,
  warnings: string[]
): LedgerMovement[] {
  const target = ledgerName.toLowerCase();
  const movements: LedgerMovement[] = [];

  const sorted = [...vouchers].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));

  let running: Decimal | null = new Decimal(openingBalance?.amount ?? 0);
  const currency = openingBalance?.currency ?? DEFAULT_CURRENCY;

  if (openingBalance === null) {
    // No opening balance means the running total has no anchor. Starting from
    // zero would silently present a relative total as an absolute balance.
    running = null;
    warnings.push(
      `TallyPrime reported no opening balance for "${ledgerName}", so running balances cannot be computed and are reported as null. The movements themselves are unaffected.`
    );
  }

  for (const voucher of sorted) {
    for (const entry of voucher.entries) {
      if (entry.ledgerName.toLowerCase() !== target) continue;

      if (entry.amount === null) {
        // One unreadable amount invalidates every balance after it.
        running = null;
        warnings.push(
          `An entry on voucher ${voucher.voucherNumber ?? '(no number)'} had an unreadable amount, so running balances from that point on are reported as null.`
        );
      } else if (running !== null) {
        running = running.plus(entry.amount.amount);
      }

      movements.push({
        date: voucher.date,
        voucherNumber: voucher.voucherNumber,
        voucherType: voucher.voucherType,
        partyLedgerName: voucher.partyLedgerName,
        narration: voucher.narration,
        contraLedgers: voucher.entries
          .filter((other) => other.ledgerName.toLowerCase() !== target)
          .map((other) => other.ledgerName),
        amount: entry.amount,
        side: entry.side,
        runningBalance: running === null ? null : { amount: running.toFixed(), currency },
      });
    }
  }

  return movements;
}
