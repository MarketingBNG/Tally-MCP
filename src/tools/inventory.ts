import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildStockItemListRequest, buildVoucherRegisterRequest } from '../tally/requests.js';
import { normalizeStockItems, normalizeVouchers, type StockItem } from '../tally/normalize.js';
import { TallyError } from '../tally/TallyError.js';
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
 * Inventory tools.
 *
 * ## Honesty about verification
 *
 * The request form here is the same collection pattern proven safe for ledgers
 * and voucher types, and TallyPrime answers it with HTTP 200. But the company
 * available for verification holds **zero stock items**, so a populated stock
 * item response has never been observed.
 *
 * Rather than invent a field mapping and present it as verified, these tools
 * promote only `name` and `parent` — safe by analogy with every other master —
 * and return everything else through the generic field extraction. The result
 * is whatever Tally actually sends, which is correct regardless of the shape,
 * at the cost of the caller reading field names as Tally spells them.
 *
 * Every tool description says this. Once real inventory data exists the
 * mapping can be tightened without changing the retrieval path.
 */

const UNVERIFIED_NOTICE =
  'VERIFICATION STATUS: this tool retrieval path has not been confirmed against a company that ' +
  'actually holds stock, because none was available. Item name and parent group are returned as ' +
  'named properties; every other value appears under "fields" with TallyPrime own field names ' +
  'rather than being renamed. If this returns nothing, first check whether the company keeps ' +
  'inventory at all — tally_get_company reports the ledger and group structure.';

const LIST_DESCRIPTION = [
  'List stock items with their closing balance and value.',
  '',
  'WHEN TO USE: to see what inventory the company holds. Returns nothing for a company that ' +
    'does not keep stock, which is a real answer rather than an error.',
  '',
  UNVERIFIED_NOTICE,
  '',
  'PAGINATION: client-side over a full fetch. A small pageSize does not make the call cheap.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

const SEARCH_DESCRIPTION = [
  'Find stock items whose name or group matches a search term.',
  '',
  'MATCHING: case-insensitive substring against the item name and its parent group.',
  '',
  UNVERIFIED_NOTICE,
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

const GET_DESCRIPTION = [
  'Fetch a single stock item by exact name, with every field TallyPrime holds for it.',
  '',
  'NOT FOUND: fails with TALLY_COMPANY_NOT_FOUND naming the item, so a typo is distinguishable ' +
    'from an item with no stock.',
  '',
  UNVERIFIED_NOTICE,
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

const MOVEMENTS_DESCRIPTION = [
  'Movements of a stock item over a period, taken from the inventory lines on vouchers.',
  '',
  'WHEN TO USE: to see what happened to an item — what came in, what went out, on which ' +
    'voucher and against which party.',
  '',
  'HOW IT IS BUILT: derived from the inventory allocations nested on vouchers in the period, ' +
    'not from a dedicated TallyPrime inventory report. TallyPrime stock movement report ID is ' +
    'not confirmed, and guessing a report ID can terminate the application, so the verified ' +
    'voucher path is used instead. Each movement therefore carries the voucher it came from.',
  '',
  'NO COMPUTED QUANTITIES: quantities and rates are returned exactly as Tally recorded them on ' +
    'each line, in Tally own format (which includes the unit, e.g. "100 nos"). Nothing is ' +
    'summed or converted between units, because unit conversion needs the item conversion ' +
    'factors and getting that wrong silently would be worse than not doing it.',
  '',
  'PERIOD: both dates or neither; omitted means the financial year containing today.',
  '',
  UNVERIFIED_NOTICE,
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

/** Inventory-line structures Tally nests on a voucher. */
const INVENTORY_LIST_TAGS = ['ALLINVENTORYENTRIES.LIST', 'INVENTORYENTRIES.LIST'];

async function fetchStockItems(
  deps: ToolDeps,
  company: string | undefined,
  allFields: boolean
): Promise<{ items: StockItem[]; warnings: string[] }> {
  await assertCompanyIsLoaded(deps, company);

  const response = await deps.client.send(
    buildStockItemListRequest(
      {
        ...(company === undefined ? {} : { company }),
        format: deps.config.tallyPreferredFormat,
      },
      allFields
    ),
    allFields ? 'report' : 'standard'
  );

  const { data, warnings } = normalizeStockItems(response.body);
  return { items: data, warnings: [...response.repairs, ...warnings] };
}

export function registerInventoryTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_list_stock_items',
    {
      description: LIST_DESCRIPTION,
      inputSchema: z.object({
        company: companySchema,
        includeAllFields: z
          .boolean()
          .optional()
          .describe('Request every field TallyPrime holds per item. Larger response.'),
        ...paginationSchema,
      }),
    },
    async (args) =>
      runTool('tally_list_stock_items', deps.logger, async () => {
        const pagination = resolvePagination(args.page, args.pageSize);
        const { items, warnings } = await fetchStockItems(
          deps,
          args.company,
          args.includeAllFields ?? false
        );
        assertResultSetFits(
          items.length,
          deps.config,
          'Use tally_search_stock_items to narrow by name or group.'
        );

        return paginate(items, pagination, warnings);
      })
  );

  server.registerTool(
    'tally_search_stock_items',
    {
      description: SEARCH_DESCRIPTION,
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe('Case-insensitive substring matched against item name and parent group.'),
        company: companySchema,
        ...paginationSchema,
      }),
    },
    async (args) =>
      runTool('tally_search_stock_items', deps.logger, async () => {
        const pagination = resolvePagination(args.page, args.pageSize);
        const { items, warnings } = await fetchStockItems(deps, args.company, false);

        const needle = args.query.toLowerCase();
        const matches = items.filter(
          (item) =>
            item.name.toLowerCase().includes(needle) ||
            (item.parent ?? '').toLowerCase().includes(needle)
        );

        return { query: args.query, ...paginate(matches, pagination, warnings) };
      })
  );

  server.registerTool(
    'tally_get_stock_item',
    {
      description: GET_DESCRIPTION,
      inputSchema: z.object({
        name: z.string().min(1).describe('Exact stock item name as it appears in TallyPrime.'),
        company: companySchema,
      }),
    },
    async (args) =>
      runTool('tally_get_stock_item', deps.logger, async () => {
        // Full detail by default: asking for one item is an investigation.
        const { items, warnings } = await fetchStockItems(deps, args.company, true);

        const item =
          items.find((candidate) => candidate.name === args.name) ??
          items.find((candidate) => candidate.name.toLowerCase() === args.name.toLowerCase());

        if (item === undefined) {
          throw new TallyError(
            'TALLY_COMPANY_NOT_FOUND',
            `No stock item named "${args.name}" exists in the loaded company.`,
            {
              suggestion:
                items.length === 0
                  ? 'This company reports no stock items at all — it may not keep inventory.'
                  : 'Check the spelling, or use tally_search_stock_items to find it by a fragment of its name.',
            }
          );
        }

        return { item, ...(warnings.length > 0 ? { warnings } : {}) };
      })
  );

  server.registerTool(
    'tally_get_inventory_movements',
    {
      description: MOVEMENTS_DESCRIPTION,
      inputSchema: z.object({
        stockItem: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Item name to filter to, matched as a case-insensitive substring. Omit to return ' +
              'every inventory movement in the period.'
          ),
        company: companySchema,
        ...dateRangeSchema,
        ...paginationSchema,
      }),
    },
    async (args) =>
      runTool('tally_get_inventory_movements', deps.logger, async () => {
        const pagination = resolvePagination(args.page, args.pageSize);
        const period = resolvePeriod(args.fromDate, args.toDate);
        await assertCompanyIsLoaded(deps, args.company);

        const response = await deps.client.send(
          buildVoucherRegisterRequest({
            ...(args.company === undefined ? {} : { company: args.company }),
            fromDate: period.fromDate,
            toDate: period.toDate,
            format: deps.config.tallyPreferredFormat,
          }),
          'report'
        );

        // Inventory lines are nested structures, so full detail is required.
        const { data: vouchers, warnings } = normalizeVouchers(response.body, true);

        const needle = args.stockItem?.toLowerCase();
        const movements: unknown[] = [];

        for (const voucher of vouchers) {
          for (const tag of INVENTORY_LIST_TAGS) {
            for (const line of voucher.nested?.[tag] ?? []) {
              const itemName = line.fields.STOCKITEMNAME ?? '';
              if (needle !== undefined && !itemName.toLowerCase().includes(needle)) continue;

              movements.push({
                stockItem: itemName,
                date: voucher.date,
                voucherNumber: voucher.voucherNumber,
                voucherType: voucher.voucherType,
                partyLedgerName: voucher.partyLedgerName,
                /** Exactly as Tally recorded it, unit included, never converted. */
                fields: line.fields,
                ...(line.nested === undefined ? {} : { nested: line.nested }),
                source: voucher.source,
              });
            }
          }
        }

        assertResultSetFits(
          movements.length,
          deps.config,
          'Narrow the date range, or filter to a single stock item.'
        );

        return {
          period,
          ...(args.stockItem === undefined ? {} : { stockItem: args.stockItem }),
          ...paginate(movements, pagination, [...response.repairs, ...warnings]),
        };
      })
  );
}
