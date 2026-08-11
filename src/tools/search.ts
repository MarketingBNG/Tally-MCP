import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  buildLedgerListRequest,
  buildStockItemListRequest,
  buildVoucherRegisterRequest,
} from '../tally/requests.js';
import { normalizeLedgers, normalizeStockItems, normalizeVouchers } from '../tally/normalize.js';
import {
  companySchema,
  dateRangeSchema,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import { resolvePagination } from '../utils/pagination.js';
import {
  assertCompanyIsLoaded,
  resolvePeriod,
  runTool,
  type ToolDeps,
} from './toolResult.js';
import { voucherMatchesAnyField } from './voucherFilters.js';

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
    'identifying summary rather than the full record. Follow up with tally_get_ledger, ' +
    'tally_get_voucher or tally_get_stock_item for detail.',
  '',
  'SCOPE AND LIMITS — read these, they affect whether an empty result means anything:',
  '  - Vouchers are searched WITHIN A DATE RANGE ONLY, defaulting to the financial year ' +
    'containing today. A voucher outside that range will not be found however well it matches. ' +
    'Widen fromDate/toDate to search further back.',
  '  - Ledgers and stock items are masters and are searched in full, ignoring the date range.',
  '  - Each type is capped (default 20 matches). "truncated" in the response tells you a cap was ' +
    'hit and the result is incomplete.',
  '  - Voucher matching covers number, party, narration, entry ledger names and every field ' +
    'value including nested structures.',
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
      runTool('tally_search', deps.logger, async () => {
        // Validates page/pageSize semantics are not silently accepted here.
        resolvePagination(1, 1);

        const period = resolvePeriod(args.fromDate, args.toDate);
        await assertCompanyIsLoaded(deps, args.company);

        const companyOption = args.company === undefined ? {} : { company: args.company };
        const types = new Set(args.entityTypes ?? ['ledger', 'voucher', 'stockItem']);
        const limit = args.limit ?? DEFAULT_LIMIT;
        const needle = args.query.toLowerCase();
        const warnings: string[] = [];

        const results: Record<string, unknown> = {};

        if (types.has('ledger')) {
          const response = await deps.client.send(
            buildLedgerListRequest({ ...companyOption, format: deps.config.tallyPreferredFormat }),
            'standard'
          );
          const { data, warnings: w } = normalizeLedgers(response.body);
          warnings.push(...response.repairs, ...w);

          const matches = data.filter(
            (ledger) =>
              ledger.name.toLowerCase().includes(needle) ||
              (ledger.parent ?? '').toLowerCase().includes(needle) ||
              (ledger.gstin ?? '').toLowerCase().includes(needle)
          );

          results.ledgers = summarise(matches, limit, (ledger) => ({
            name: ledger.name,
            parent: ledger.parent,
            closingBalance: ledger.closingBalance,
            source: ledger.source,
          }));
        }

        if (types.has('voucher')) {
          const response = await deps.client.send(
            buildVoucherRegisterRequest({
              ...companyOption,
              fromDate: period.fromDate,
              toDate: period.toDate,
              format: deps.config.tallyPreferredFormat,
            }),
            'report'
          );
          // Full fields so the search covers nested references too.
          const { data, warnings: w } = normalizeVouchers(response.body, true);
          warnings.push(...response.repairs, ...w);

          const matches = data.filter((voucher) => {
            const haystack = [
              voucher.voucherNumber,
              voucher.partyLedgerName,
              voucher.narration,
              ...voucher.entries.map((entry) => entry.ledgerName),
            ]
              .filter((value): value is string => value !== null)
              .join(' ')
              .toLowerCase();

            return haystack.includes(needle) || voucherMatchesAnyField(voucher, args.query);
          });

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
          const response = await deps.client.send(
            buildStockItemListRequest({
              ...companyOption,
              format: deps.config.tallyPreferredFormat,
            }),
            'standard'
          );
          const { data, warnings: w } = normalizeStockItems(response.body);
          warnings.push(...response.repairs, ...w);

          const matches = data.filter(
            (item) =>
              item.name.toLowerCase().includes(needle) ||
              (item.parent ?? '').toLowerCase().includes(needle)
          );

          results.stockItems = summarise(matches, limit, (item) => ({
            name: item.name,
            parent: item.parent,
            source: item.source,
          }));
        }

        return {
          query: args.query,
          /** Vouchers only — masters are not date-scoped. */
          voucherPeriodSearched: period,
          ...results,
          ...(warnings.length > 0 ? { warnings } : {}),
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
