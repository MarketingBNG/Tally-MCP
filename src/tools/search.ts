import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  companySchema,
  dateRangeSchema,
  PERIOD_NOTE,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import { resolvePeriodForCompany, runTool, type ToolDeps } from './toolResult.js';
import { voucherMatchesAnyField } from './voucherFilters.js';
import { matchesText } from '../utils/text.js';
import { fetchLedgers } from './ledgers.js';
import { fetchStockItems } from './inventory.js';
import { fetchVouchers } from './vouchers.js';

/**
 * Cross-entity search.
 *
 * A convenience for "where does this name or number appear?", when the entity
 * type is not known up front — a name might be a ledger, a party on a voucher,
 * or a stock item.
 *
 * ## Deliberately bounded
 *
 * This is **not** an unbounded database scan. Vouchers are searched only within
 * a date range, defaulting to the current financial year, because Tally returns
 * a whole period in one response and an unbounded voucher search would be the
 * slowest thing this server could do. Each entity type returns a capped number
 * of matches, and the response says when a cap was hit — a truncated result
 * that looks complete is worse than an admitted limit.
 */

/** Per-type match cap. Small on purpose: this is an orientation tool. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const DESCRIPTION = [
  'Search across ledgers, vouchers and stock items at once for a name, number or reference.',
  '',
  'WHEN TO USE: when you do not yet know what kind of thing you are looking for — a name that ' +
    'might be a ledger or a party, or a reference number that might be on a voucher. Once the ' +
    'entity type is known, the specific tool is better: it returns full records and supports ' +
    'proper filters.',
  '',
  'RETURNS: matches grouped by entity type (ledgers, vouchers, stockItems), each with a small ' +
    'identifying summary rather than the full record. Follow up with tally_get_masters type "ledger", ' +
    'tally_get_vouchers or tally_get_masters type "stockItem" (by name) for detail.',
  '',
  'SCOPE AND LIMITS — read these, they affect whether an empty result means anything:',
  '  - Vouchers are searched WITHIN THE DATE RANGE ONLY. A voucher outside it will not be found ' +
    'however well it matches; widen fromDate/toDate to search further back.',
  '  - Ledgers and stock items are masters and are searched in full, ignoring the date range.',
  '  - Each type is capped (default 20 matches). "truncated" in the response tells you a cap was ' +
    'hit and the result is incomplete.',
  '  - Voucher matching covers number, party, narration, entry ledger names and every field ' +
    'value including nested structures. Each field is matched on its own, so a term cannot match ' +
    'by spanning two unrelated fields.',
  '',
  PERIOD_NOTE,
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

export function registerSearchTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_search',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        query: z.string().min(1).describe('Case-insensitive substring to look for.'),
        entityTypes: z
          .array(z.enum(['ledger', 'voucher', 'stockItem']))
          .optional()
          .describe(
            'Which entity types to search. Defaults to all three. Restricting this is the main ' +
              'way to make the call faster, since each type costs a separate Tally request.'
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(`Maximum matches per entity type. Defaults to ${String(DEFAULT_LIMIT)}.`),
        company: companySchema,
        ...dateRangeSchema,
      }),
    },
    async (args) =>
      runTool('tally_search', deps, async () => {
        const period = await resolvePeriodForCompany(deps, args.fromDate, args.toDate, args.company);

        const types = new Set(args.entityTypes ?? ['ledger', 'voucher', 'stockItem']);
        const limit = args.limit ?? DEFAULT_LIMIT;
        const warnings: string[] = [];

        // Typed rather than `unknown`, so the envelope's row count and
        // truncation flag can be derived from the same capped lists the
        // caller sees rather than recomputed alongside them.
        const results: Record<string, { total: number; truncated: boolean; matches: unknown[] }> =
          {};

        if (types.has('ledger')) {
          const { ledgers: data, warnings: w } = await fetchLedgers(deps, args.company);
          warnings.push(...w);

          const matches = data.filter((ledger) =>
            matchesText(args.query, ledger.name, ledger.parent, ledger.gstin)
          );

          results.ledgers = summarise(matches, limit, (ledger) => ({
            name: ledger.name,
            parent: ledger.parent,
            closingBalance: ledger.closingBalance,
            source: ledger.source,
          }));
        }

        if (types.has('voucher')) {
          // Full fields so the search covers nested references too.
          const { vouchers: data, warnings: w } = await fetchVouchers(
            deps,
            args.company,
            period,
            true
          );
          warnings.push(...w);

          // Matched field by field rather than against one joined string, so a
          // term cannot match by straddling the boundary between two unrelated
          // fields — a false positive that would look like a real hit.
          const matches = data.filter(
            (voucher) =>
              matchesText(
                args.query,
                voucher.voucherNumber,
                voucher.partyLedgerName,
                voucher.narration,
                ...voucher.entries.map((entry) => entry.ledgerName)
              ) || voucherMatchesAnyField(voucher, args.query)
          );

          results.vouchers = summarise(matches, limit, (voucher) => ({
            date: voucher.date,
            voucherNumber: voucher.voucherNumber,
            voucherType: voucher.voucherType,
            partyLedgerName: voucher.partyLedgerName,
            narration: voucher.narration,
            source: voucher.source,
          }));
        }

        if (types.has('stockItem')) {
          const { items: data, warnings: w } = await fetchStockItems(deps, args.company, false);
          warnings.push(...w);

          const matches = data.filter((item) => matchesText(args.query, item.name, item.parent));

          results.stockItems = summarise(matches, limit, (item) => ({
            name: item.name,
            parent: item.parent,
            source: item.source,
          }));
        }

        // Truncation is per entity type here, and the envelope carries one
        // flag — so ANY capped list makes the whole answer partial. Reporting
        // false because two of three lists were complete would be exactly the
        // silent-truncation failure §6 rule 4 exists to prevent.
        const summaries = Object.values(results);

        return {
          data: {
            query: args.query,
            /** Vouchers only — masters are not date-scoped. */
            voucherPeriodSearched: period,
            ...results,
            ...(warnings.length > 0 ? { warnings } : {}),
          },
          rows: summaries.reduce((count, summary) => count + summary.matches.length, 0),
          truncated: summaries.some((summary) => summary.truncated),
        };
      })
  );
}

/**
 * Cap a match list, reporting whether anything was dropped.
 *
 * `truncated` is not decoration: without it a capped list is
 * indistinguishable from a complete one, and "3 matches" would be read as
 * "only 3 exist".
 */
function summarise<T, R>(
  matches: readonly T[],
  limit: number,
  project: (item: T) => R
): { total: number; truncated: boolean; matches: R[] } {
  return {
    total: matches.length,
    truncated: matches.length > limit,
    matches: matches.slice(0, limit).map(project),
  };
}
