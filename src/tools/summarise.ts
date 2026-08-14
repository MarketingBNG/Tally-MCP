import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Voucher } from '../tally/normalize.js';
import { DEFAULT_CURRENCY, type Money } from '../utils/numbers.js';
import {
  companySchema,
  dateRangeSchema,
  paginationSchema,
  PERIOD_NOTE,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import { paginate, resolvePagination } from '../utils/pagination.js';
import { matchesVoucherFilters } from './voucherFilters.js';
import { fetchLedgers } from './ledgers.js';
import { fetchVouchers } from './vouchers.js';
import { fromPage, resolvePeriodForCompany, runTool, type ToolDeps } from './toolResult.js';

/**
 * `tally_summarise_movements`: totals per ledger, group, month, voucher type or
 * party, computed here in Decimal instead of by reading every row.
 *
 * ## Why this exists
 *
 * Two reasons, and the second is the important one.
 *
 * **Tokens.** Answering "what did we spend on freight this year" by listing 453
 * vouchers costs ~17,000 tokens and asks the model to add up 900 numbers. The
 * same answer as one row per month is ~300 tokens. Measured on a real company:
 * the voucher list is the single largest response this server produces.
 *
 * **Arithmetic.** §6 rule 1 says this server does not let the model do the
 * arithmetic on accounting figures. Before this tool there was no way to obtain a
 * total at all — the only path was to return the rows and hope. Every figure here
 * is a Decimal sum of amounts Tally reported, returned with the count of what
 * went into it.
 *
 * ## What is summed, and why it is entries rather than vouchers
 *
 * **Ledger ENTRIES are grouped, never vouchers.** A voucher has no single
 * amount — its entries net to zero by construction — so "the total of these
 * vouchers" is not a fact but a choice of which leg to call the transaction.
 * That choice belongs to the reader, and the voucher tools already refuse to make
 * it (see the family-search note in vouchers.ts).
 *
 * An entry, by contrast, belongs to exactly one ledger and one voucher, so
 * summing entries per dimension double-counts nothing and omits nothing. It has a
 * useful property: because every voucher balances, **the net of every group in an
 * unfiltered summary is exactly zero**. That is a checkable invariant rather than
 * a claim, and it is reported as `allGroupsNetToZero`.
 */

const GROUP_BY = ['ledger', 'group', 'month', 'voucherType', 'party'] as const;
type GroupBy = (typeof GROUP_BY)[number];

const DESCRIPTION = [
  'Totals per ledger, account group, month, voucher type or party — computed on the server in ' +
    'exact decimal arithmetic, not by you adding up rows.',
  '',
  'WHEN TO USE: for any question answered by a total, a subtotal or a trend rather than by ' +
    'individual transactions — "what did we spend on freight", "sales by month", "which expense ' +
    'accounts moved most". Prefer this over tally_get_vouchers whenever the answer is a figure: ' +
    'it is far smaller and the arithmetic is exact.',
  '',
  'RETURNS: one row per group with the number of vouchers and entries behind it, the total debit ' +
    'and total credit as magnitudes, and the net in TallyPrime own sign convention.',
  '',
  'WHAT IS SUMMED: ledger ENTRIES, not vouchers. A voucher has no single amount — its entries ' +
    'net to zero — so totalling vouchers would mean choosing which leg counts as "the ' +
    'transaction", which is your judgement to make and not a fact. Each entry belongs to exactly ' +
    'one ledger and one voucher, so these totals double-count nothing.',
  '',
  'THE BUILT-IN CHECK: because every voucher balances, an unfiltered summary must net to exactly ' +
    'zero across all groups. That is reported as "allGroupsNetToZero". If it is false on an ' +
    'unfiltered call, say so — the books do not balance and tally_check_tie_out will say where.',
  '',
  'SIGNS: net is credit minus debit, which is TallyPrime own convention — a DEBIT net arrives ' +
    'NEGATIVE and a credit net positive, matching the closing balance Tally reports for a ledger. ' +
    'Report the magnitude and name the side rather than quoting the minus sign, which would ' +
    'contradict what the user sees on Tally screen. totalDebit and totalCredit are magnitudes.',
  '',
  'TO TOTAL ONE SIDE — the common case — pass "ledger". Grouping every entry by month nets to ' +
    'nil in every month, because both sides of each transaction fall in the same month; that is ' +
    'arithmetic, not a finding. For "sales by month" pass ledger:"Sales" with groupBy:"month", ' +
    'which counts only the sales entries.',
  '',
  'AN ENTRY WITH AN UNREADABLE AMOUNT is excluded from the totals and counted in ' +
    '"entriesExcludedFromTotals" on that row, with a warning. It is never treated as zero.',
  '',
  PERIOD_NOTE,
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

export interface MovementSummaryRow {
  /** The group value. "(none)" where Tally recorded nothing for the dimension. */
  key: string;
  /** Distinct vouchers contributing to this row. */
  voucherCount: number;
  entryCount: number;
  /** Magnitudes, not signed: the side is named by the field. */
  totalDebit: Money;
  totalCredit: Money;
  /**
   * Credit minus debit, which IS TallyPrime's own sign convention: a debit net
   * arrives negative and a credit net positive, exactly as Tally reports a
   * ledger's closing balance.
   *
   * Verified against the master 2026-08-13: the sales ledger summarises to
   * 412,276.25 and TallyPrime reports the same ledger's closing balance as
   * 412,276.25. An earlier version negated this and reported −412,276.25 —
   * arithmetically consistent, and the opposite of what the accountant sees.
   */
  net: Money;
  /** Only present when something had to be left out of the totals. */
  entriesExcludedFromTotals?: number;
}

interface Bucket {
  debit: Decimal;
  credit: Decimal;
  entries: number;
  vouchers: Set<string>;
  excluded: number;
}

/**
 * Group entries and total them.
 *
 * Exported for direct testing: the arithmetic is the whole value of this tool, so
 * it is tested against fixtures rather than only through the tool envelope.
 */
export function summariseMovements(
  vouchers: readonly Voucher[],
  groupBy: GroupBy,
  parentOf: (ledgerName: string) => string | null,
  warnings: string[],
  /**
   * Restrict which ENTRIES are counted, not which vouchers.
   *
   * The distinction is the difference between an answer and a zero. A
   * voucher-level filter keeps every entry of a matching voucher, so both sides
   * of each transaction land in the totals and every row nets to nil — asking
   * "sales by month" that way returned twelve months of zero, which looks like a
   * finding and is actually the filter. Restricting entries keeps the sales leg
   * alone, which is the figure being asked for.
   */
  includeEntry: (ledgerName: string) => boolean = () => true
): { rows: MovementSummaryRow[]; allNetToZero: boolean; currency: string } {
  const buckets = new Map<string, Bucket>();
  let currency = DEFAULT_CURRENCY;

  for (const voucher of vouchers) {
    // A cancelled voucher posts nothing. Including it would inflate every total
    // with amounts the books do not carry.
    if (voucher.isCancelled) continue;

    const voucherId = voucher.guid ?? voucher.voucherNumber ?? '(unidentified)';

    for (const entry of voucher.entries) {
      if (!includeEntry(entry.ledgerName)) continue;

      const key = keyFor(groupBy, voucher, entry.ledgerName, parentOf);

      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = {
          debit: new Decimal(0),
          credit: new Decimal(0),
          entries: 0,
          vouchers: new Set(),
          excluded: 0,
        };
        buckets.set(key, bucket);
      }

      bucket.entries += 1;
      bucket.vouchers.add(voucherId);

      if (entry.amount === null) {
        bucket.excluded += 1;
        continue;
      }

      currency = entry.amount.currency;
      const magnitude = new Decimal(entry.amount.amount).abs();
      if (entry.side === 'debit') bucket.debit = bucket.debit.plus(magnitude);
      else bucket.credit = bucket.credit.plus(magnitude);
    }
  }

  const rows: MovementSummaryRow[] = [];
  let net = new Decimal(0);
  let excludedTotal = 0;

  for (const [key, bucket] of buckets) {
    // credit − debit, NOT negated. Tally encodes a debit as negative in both the
    // entry amounts and the ledger closing balance, so this matches the master.
    const rowNet = bucket.credit.minus(bucket.debit);
    net = net.plus(rowNet);
    excludedTotal += bucket.excluded;

    rows.push({
      key,
      voucherCount: bucket.vouchers.size,
      entryCount: bucket.entries,
      totalDebit: { amount: bucket.debit.toFixed(), currency },
      totalCredit: { amount: bucket.credit.toFixed(), currency },
      net: { amount: rowNet.toFixed(), currency },
      ...(bucket.excluded > 0 ? { entriesExcludedFromTotals: bucket.excluded } : {}),
    });
  }

  if (excludedTotal > 0) {
    warnings.push(
      `${String(excludedTotal)} entr${excludedTotal === 1 ? 'y' : 'ies'} carried an amount TallyPrime did not report readably and are excluded from the totals, so the affected rows are understated. Each such row reports its own count as entriesExcludedFromTotals.`
    );
  }

  // Largest absolute net first: on an expense or sales question that is the
  // order the reader wants, and it makes a truncated page the significant part
  // rather than an alphabetical accident.
  rows.sort((a, b) => new Decimal(b.net.amount).abs().comparedTo(new Decimal(a.net.amount).abs()));

  return { rows, allNetToZero: net.isZero(), currency };
}

function keyFor(
  groupBy: GroupBy,
  voucher: Voucher,
  ledgerName: string,
  parentOf: (ledgerName: string) => string | null
): string {
  switch (groupBy) {
    case 'ledger':
      return ledgerName === '' ? '(none)' : ledgerName;
    case 'group':
      return parentOf(ledgerName) ?? '(ungrouped)';
    case 'month':
      // ISO year-month, so it sorts and cannot be read as a different calendar.
      return voucher.date === null ? '(no date)' : voucher.date.slice(0, 7);
    case 'voucherType':
      return voucher.voucherType ?? '(none)';
    case 'party':
      return voucher.partyLedgerName ?? '(none)';
  }
}

export function registerSummaryTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_summarise_movements',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        groupBy: z
          .enum(GROUP_BY)
          .describe(
            'Which dimension to total by. "group" uses the account group each ledger belongs to ' +
              'and costs one extra (cached) master fetch.'
          ),
        query: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Restrict to vouchers matching this text before totalling — voucher number, party, ' +
              'narration or entry ledger name, case-insensitive substring. Note that filtering ' +
              'breaks the net-to-zero check, which is expected.'
          ),
        ledger: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Count ONLY entries on ledgers whose name contains this text, case-insensitive. This ' +
              'restricts the ENTRIES totalled, not the vouchers selected, which is what makes ' +
              '"sales by month" work: combine ledger:"Sales" with groupBy:"month". Restricting ' +
              'vouchers instead would keep both sides of every transaction and every row would ' +
              'total nil.'
          ),
        voucherType: z
          .string()
          .min(1)
          .optional()
          .describe('Restrict to one voucher type, exact and case-insensitive.'),
        company: companySchema,
        ...dateRangeSchema,
        ...paginationSchema,
      }),
    },
    async (args) =>
      runTool('tally_summarise_movements', deps, async () => {
        const period = await resolvePeriodForCompany(deps, args.fromDate, args.toDate, args.company);
        const pagination = resolvePagination(args.page, args.pageSize);

        // The lean fetch: no scalar fields, no nested structures. This is the
        // cheapest voucher read there is, and it shares its cache entry with
        // tally_check_tie_out and the plain voucher list.
        const { vouchers, warnings } = await fetchVouchers(deps, args.company, period);

        // `ledger` is deliberately NOT here: it restricts entries, below, rather
        // than selecting vouchers. Everything in this map is a voucher-level test.
        const filters = {
          ...(args.query === undefined ? {} : { query: args.query }),
          ...(args.voucherType === undefined ? {} : { voucherType: args.voucherType }),
        };
        // Either kind of restriction breaks the net-to-zero invariant, so both
        // count when deciding whether it may be claimed.
        const hasFilters = Object.keys(filters).length > 0 || args.ledger !== undefined;
        const selected = hasFilters
          ? vouchers.filter((voucher) => matchesVoucherFilters(voucher, filters))
          : vouchers;

        // Only fetched when grouping by it: on every other dimension this would
        // be a master fetch nobody reads.
        let parentOf: (ledgerName: string) => string | null = () => null;
        if (args.groupBy === 'group') {
          const { ledgers, warnings: ledgerWarnings } = await fetchLedgers(deps, args.company);
          warnings.push(...ledgerWarnings);
          const byName = new Map(
            ledgers.map((ledger) => [ledger.name.trim().toLowerCase(), ledger.parent])
          );
          parentOf = (name) => byName.get(name.trim().toLowerCase()) ?? null;
        }

        const entryNeedle = args.ledger?.trim().toLowerCase();
        const includeEntry =
          entryNeedle === undefined || entryNeedle === ''
            ? undefined
            : (ledgerName: string) => ledgerName.toLowerCase().includes(entryNeedle);

        const summary = summariseMovements(
          selected,
          args.groupBy,
          parentOf,
          warnings,
          includeEntry
        );

        return fromPage(paginate(summary.rows, pagination, warnings), {
          period,
          groupBy: args.groupBy,
          ...(Object.keys(filters).length > 0 ? { filters } : {}),
          ...(args.ledger === undefined ? {} : { entriesRestrictedToLedger: args.ledger }),
          /**
           * The invariant, claimed only where it holds. Filtering selects one
           * side of transactions whose other side is excluded, so a filtered
           * summary is not expected to net to zero and saying otherwise would
           * turn a normal result into an apparent failure.
           */
          ...(hasFilters
            ? {
                netToZeroNotChecked:
                  'Filters were applied, so the groups are not expected to net to zero.',
              }
            : { allGroupsNetToZero: summary.allNetToZero }),
          basis:
            'Ledger entries grouped and totalled in exact decimal arithmetic. Debits and credits ' +
            'are magnitudes; net is credit minus debit in TallyPrime own signs, so a debit net is ' +
            'negative. Cancelled vouchers are excluded.',
        });
      })
  );
}
